import { expect } from "chai";
import { ContractTransactionReceipt, hexlify, randomBytes, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Delegation, SSZHelpers, StakingVault } from "typechain-types";

import {
  computeDepositDataRoot,
  days,
  ether,
  generateValidator,
  impersonate,
  log,
  prepareLocalMerkleTree,
  updateBalance,
} from "lib";
import {
  getProtocolContext,
  getReportTimeElapsed,
  norEnsureOperators,
  OracleReportParams,
  ProtocolContext,
  report,
  sdvtEnsureOperators,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";
import { CURATED_MODULE_ID, MAX_DEPOSIT, ONE_DAY, SIMPLE_DVT_MODULE_ID, ZERO_HASH } from "test/suite/constants";

const LIDO_DEPOSIT = ether("640");

const VALIDATORS_PER_VAULT = 2n;
const VALIDATOR_DEPOSIT_SIZE = ether("32");
const VAULT_DEPOSIT = VALIDATOR_DEPOSIT_SIZE * VALIDATORS_PER_VAULT;

const ONE_YEAR = 365n * ONE_DAY;
const TARGET_APR = 3_00n; // 3% APR
const PROTOCOL_FEE = 10_00n; // 10% fee (5% treasury + 5% node operators)
const TOTAL_BASIS_POINTS = 100_00n; // 100%

const VAULT_CONNECTION_DEPOSIT = ether("1");
const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator performance fee

describe("Scenario: Staking Vaults Happy Path", () => {
  let ctx: ProtocolContext;

  let ethHolder: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let curator: HardhatEthersSigner;

  let depositContract: string;

  const reserveRatio = 10_00n; // 10% of ETH allocation as reserve
  const rebalanceThreshold = 8_00n; // 8% is a threshold to force rebalance on the vault
  const mintableRatio = TOTAL_BASIS_POINTS - reserveRatio; // 90% LTV

  let delegation: Delegation;
  let stakingVault: StakingVault;
  let stakingVaultAddress: string;
  let stakingVaultBeaconBalance = 0n;
  let stakingVaultMaxMintingShares = 0n;

  const treasuryFeeBP = 5_00n; // 5% of the treasury fee

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [ethHolder, owner, nodeOperator, curator] = await ethers.getSigners();

    const { depositSecurityModule } = ctx.contracts;
    depositContract = await depositSecurityModule.DEPOSIT_CONTRACT();

    // add ETH to NO for PDG deposit + gas
    await setBalance(nodeOperator.address, ether((VALIDATORS_PER_VAULT + 1n).toString()));

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  beforeEach(bailOnFailure);

  async function calculateReportParams() {
    const { beaconBalance } = await ctx.contracts.lido.getBeaconStat();
    const { timeElapsed } = await getReportTimeElapsed(ctx);

    log.debug("Report time elapsed", { timeElapsed });

    const gross = (TARGET_APR * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - PROTOCOL_FEE); // take into account 10% Lido fee
    const elapsedProtocolReward = (beaconBalance * gross * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;
    const elapsedVaultReward = (VAULT_DEPOSIT * gross * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;

    log.debug("Report values", {
      "Elapsed rewards": elapsedProtocolReward,
      "Elapsed vault rewards": elapsedVaultReward,
    });

    return { elapsedProtocolReward, elapsedVaultReward };
  }

  async function addRewards(rewards: bigint) {
    if (!stakingVaultAddress || !stakingVault) {
      throw new Error("Staking Vault is not initialized");
    }

    const vault101Balance = (await ethers.provider.getBalance(stakingVaultAddress)) + rewards;
    await updateBalance(stakingVaultAddress, vault101Balance);

    // Use beacon balance to calculate the vault value
    return vault101Balance + stakingVaultBeaconBalance;
  }

  it("Should have at least 10 deposited node operators in NOR", async () => {
    const { depositSecurityModule, lido } = ctx.contracts;

    await norEnsureOperators(ctx, 10n, 1n);
    await sdvtEnsureOperators(ctx, 10n, 1n);
    expect(await ctx.contracts.nor.getNodeOperatorsCount()).to.be.at.least(10n);
    expect(await ctx.contracts.sdvt.getNodeOperatorsCount()).to.be.at.least(10n);

    // Send 640 ETH to lido
    await lido.connect(ethHolder).submit(ZeroAddress, { value: LIDO_DEPOSIT });

    const dsmSigner = await impersonate(depositSecurityModule.address, LIDO_DEPOSIT);
    await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);
    await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, SIMPLE_DVT_MODULE_ID, ZERO_HASH);

    const reportData: Partial<OracleReportParams> = {
      clDiff: LIDO_DEPOSIT,
      clAppearedValidators: 20n,
    };

    await report(ctx, reportData);
  });

  it("Should have vaults factory deployed and adopted by DAO", async () => {
    const { stakingVaultFactory, stakingVaultBeacon } = ctx.contracts;

    const implAddress = await stakingVaultBeacon.implementation();
    const delegationAddress = await stakingVaultFactory.DELEGATION_IMPL();

    const _stakingVault = await ethers.getContractAt("StakingVault", implAddress);
    const _delegation = await ethers.getContractAt("Delegation", delegationAddress);

    expect(await _stakingVault.DEPOSIT_CONTRACT()).to.equal(depositContract);
    expect(await _delegation.STETH()).to.equal(ctx.contracts.lido.address);

    // TODO: check what else should be validated here
  });

  it("Should allow Owner to create vault and assign NodeOperator and Curator roles", async () => {
    const { stakingVaultFactory } = ctx.contracts;

    // Owner can create a vault with operator as a node operator
    const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
      {
        defaultAdmin: owner,
        nodeOperatorManager: nodeOperator,
        assetRecoverer: curator,
        nodeOperatorFeeBP: VAULT_NODE_OPERATOR_FEE,
        confirmExpiry: days(7n),
        funders: [curator],
        withdrawers: [curator],
        minters: [curator],
        burners: [curator],
        rebalancers: [curator],
        depositPausers: [curator],
        depositResumers: [curator],
        validatorExitRequesters: [curator],
        validatorWithdrawalTriggerers: [curator],
        disconnecters: [curator],
        nodeOperatorFeeClaimers: [nodeOperator],
        nodeOperatorRewardAdjusters: [nodeOperator],
        trustedWithdrawDepositors: [curator],
        unknownValidatorProvers: [curator],
        pdgCompensators: [curator],
      },
      "0x",
    );

    const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    expect(createVaultEvents.length).to.equal(1n);

    stakingVault = await ethers.getContractAt("StakingVault", createVaultEvents[0].args?.vault);
    delegation = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);

    expect(await isSoleRoleMember(owner, await delegation.DEFAULT_ADMIN_ROLE())).to.be.true;

    expect(await isSoleRoleMember(nodeOperator, await delegation.NODE_OPERATOR_MANAGER_ROLE())).to.be.true;
    expect(await isSoleRoleMember(nodeOperator, await delegation.NODE_OPERATOR_FEE_CLAIM_ROLE())).to.be.true;

    expect(await isSoleRoleMember(curator, await delegation.FUND_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.WITHDRAW_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.MINT_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.BURN_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.REBALANCE_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.RESUME_BEACON_CHAIN_DEPOSITS_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.REQUEST_VALIDATOR_EXIT_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.VOLUNTARY_DISCONNECT_ROLE())).to.be.true;
  });

  it("Should allow Lido to recognize vaults and connect them to accounting", async () => {
    const { lido, vaultHub } = ctx.contracts;

    expect(await stakingVault.locked()).to.equal(0); // no ETH locked yet

    const votingSigner = await ctx.getSigner("voting");
    await lido.connect(votingSigner).setMaxExternalRatioBP(20_00n);

    // only equivalent of 10.0% of TVL can be minted as stETH on the vault
    const shareLimit = (await lido.getTotalShares()) / 10n; // 10% of total shares

    const agentSigner = await ctx.getSigner("agent");

    await vaultHub
      .connect(agentSigner)
      .connectVault(stakingVault, shareLimit, reserveRatio, rebalanceThreshold, treasuryFeeBP);

    expect(await vaultHub.vaultsCount()).to.equal(1n);
    expect(await stakingVault.locked()).to.equal(VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow Curator to fund vault via delegation contract", async () => {
    await delegation.connect(curator).fund({ value: VAULT_DEPOSIT });

    const vaultBalance = await ethers.provider.getBalance(stakingVault);

    expect(vaultBalance).to.equal(VAULT_DEPOSIT);
    expect(await stakingVault.valuation()).to.equal(VAULT_DEPOSIT);
  });

  it("Should allow NodeOperator to deposit validators from the vault via PDG", async () => {
    const keysToAdd = VALIDATORS_PER_VAULT;

    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const predepositAmount = await ctx.contracts.predepositGuarantee.PREDEPOSIT_AMOUNT();

    const validators: {
      container: SSZHelpers.ValidatorStruct;
      index: number;
      proof: string[];
    }[] = [];

    // TODO: BLS signature support
    for (let i = 0; i < keysToAdd; i++) {
      validators.push({ container: generateValidator(withdrawalCredentials), index: 0, proof: [] });
    }

    const predeposits = validators.map((validator) => {
      const pubkey = hexlify(validator.container.pubkey);
      const signature = hexlify(randomBytes(96));
      return {
        pubkey: pubkey,
        signature: signature,
        amount: predepositAmount,
        depositDataRoot: computeDepositDataRoot(withdrawalCredentials, pubkey, signature, predepositAmount),
      };
    });

    const pdg = await ctx.contracts.predepositGuarantee.connect(nodeOperator);

    // top up PDG balance
    await pdg.topUpNodeOperatorBalance(nodeOperator, { value: ether(VALIDATORS_PER_VAULT.toString()) });

    // predeposit validators
    await pdg.predeposit(stakingVault, predeposits);

    const slot = await pdg.SLOT_CHANGE_GI_FIRST_VALIDATOR();

    const mockCLtree = await prepareLocalMerkleTree(await pdg.GI_FIRST_VALIDATOR_AFTER_CHANGE());

    for (let index = 0; index < validators.length; index++) {
      const validator = validators[index];
      validator.index = (await mockCLtree.addValidator(validator.container)).validatorIndex;
    }

    const { childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(Number(slot) + 100);

    for (let index = 0; index < validators.length; index++) {
      const validator = validators[index];
      validator.proof = await mockCLtree.buildProof(validator.index, beaconBlockHeader);
    }

    const witnesses = validators.map((validator) => ({
      proof: validator.proof,
      pubkey: hexlify(validator.container.pubkey),
      validatorIndex: validator.index,
      childBlockTimestamp,
    }));

    const postDepositAmount = VALIDATOR_DEPOSIT_SIZE - predepositAmount;
    const postdeposits = validators.map((validator) => {
      const pubkey = hexlify(validator.container.pubkey);
      const signature = hexlify(randomBytes(96));

      return {
        pubkey,
        signature,
        amount: postDepositAmount,
        depositDataRoot: computeDepositDataRoot(withdrawalCredentials, pubkey, signature, postDepositAmount),
      };
    });

    await pdg.proveAndDeposit(witnesses, postdeposits, stakingVault);

    stakingVaultBeaconBalance += VAULT_DEPOSIT;
    stakingVaultAddress = await stakingVault.getAddress();

    const vaultBalance = await ethers.provider.getBalance(stakingVault);
    expect(vaultBalance).to.equal(0n);
    expect(await stakingVault.valuation()).to.equal(VAULT_DEPOSIT);
  });

  it("Should allow Curator to mint max stETH", async () => {
    const { vaultHub, lido } = ctx.contracts;

    // Calculate the max stETH that can be minted on the vault 101 with the given LTV
    stakingVaultMaxMintingShares = await lido.getSharesByPooledEth(
      (VAULT_DEPOSIT * mintableRatio) / TOTAL_BASIS_POINTS,
    );

    log.debug("Staking Vault", {
      "Staking Vault Address": stakingVaultAddress,
      "Total ETH": await stakingVault.valuation(),
      "Max shares": stakingVaultMaxMintingShares,
    });

    // Validate minting with the cap
    const mintOverLimitTx = delegation.connect(curator).mintShares(curator, stakingVaultMaxMintingShares + 1n);
    await expect(mintOverLimitTx)
      .to.be.revertedWithCustomError(vaultHub, "InsufficientValuationToMint")
      .withArgs(stakingVault, stakingVault.valuation());

    const mintTx = await delegation.connect(curator).mintShares(curator, stakingVaultMaxMintingShares);
    const mintTxReceipt = (await mintTx.wait()) as ContractTransactionReceipt;

    const mintEvents = ctx.getEvents(mintTxReceipt, "MintedSharesOnVault");
    expect(mintEvents.length).to.equal(1n);
    expect(mintEvents[0].args.vault).to.equal(stakingVaultAddress);
    expect(mintEvents[0].args.amountOfShares).to.equal(stakingVaultMaxMintingShares);

    const lockedEvents = ctx.getEvents(mintTxReceipt, "LockedIncreased", [stakingVault.interface]);
    expect(lockedEvents.length).to.equal(1n);
    expect(lockedEvents[0].args?.locked).to.equal(VAULT_DEPOSIT);

    expect(await stakingVault.locked()).to.equal(VAULT_DEPOSIT);

    log.debug("Staking Vault", {
      "Staking Vault Minted Shares": stakingVaultMaxMintingShares,
      "Staking Vault Locked": VAULT_DEPOSIT,
    });
  });

  it("Should rebase simulating 3% stETH APR", async () => {
    const { vaultHub } = ctx.contracts;

    const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
    const vaultValue = await addRewards(elapsedVaultReward);

    const params = {
      clDiff: elapsedProtocolReward,
      excludeVaultsBalances: true,
      vaultValues: [vaultValue],
      inOutDeltas: [VAULT_DEPOSIT],
    } as OracleReportParams;

    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };
    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

    const socket = await vaultHub["vaultSocket(address)"](stakingVaultAddress);
    expect(socket.sharesMinted).to.be.gt(stakingVaultMaxMintingShares);

    const errorReportingEvent = ctx.getEvents(reportTxReceipt, "OnReportFailed", [stakingVault.interface]);
    expect(errorReportingEvent.length).to.equal(0n);

    const vaultReportedEvent = ctx.getEvents(reportTxReceipt, "Reported", [stakingVault.interface]);
    expect(vaultReportedEvent.length).to.equal(1n);

    expect(vaultReportedEvent[0].args?.valuation).to.equal(vaultValue);
    expect(vaultReportedEvent[0].args?.inOutDelta).to.equal(VAULT_DEPOSIT);
    // TODO: add assertions or locked values and rewards

    expect(await delegation.nodeOperatorUnclaimedFee()).to.be.gt(0n);
  });

  it("Should allow Operator to claim performance fees", async () => {
    const performanceFee = await delegation.nodeOperatorUnclaimedFee();
    log.debug("Staking Vault stats", {
      "Staking Vault performance fee": ethers.formatEther(performanceFee),
    });

    const operatorBalanceBefore = await ethers.provider.getBalance(nodeOperator);

    const claimPerformanceFeesTx = await delegation.connect(nodeOperator).claimNodeOperatorFee(nodeOperator);
    const claimPerformanceFeesTxReceipt = (await claimPerformanceFeesTx.wait()) as ContractTransactionReceipt;

    const operatorBalanceAfter = await ethers.provider.getBalance(nodeOperator);
    const gasFee = claimPerformanceFeesTxReceipt.gasPrice * claimPerformanceFeesTxReceipt.cumulativeGasUsed;

    log.debug("Operator's StETH balance", {
      "Balance before": ethers.formatEther(operatorBalanceBefore),
      "Balance after": ethers.formatEther(operatorBalanceAfter),
      "Gas used": claimPerformanceFeesTxReceipt.cumulativeGasUsed,
      "Gas fees": ethers.formatEther(gasFee),
    });

    expect(operatorBalanceAfter).to.equal(operatorBalanceBefore + performanceFee - gasFee);
  });

  it("Should allow Curator to burn minted shares", async () => {
    const { lido, vaultHub } = ctx.contracts;

    // Token master can approve the vault to burn the shares
    await lido.connect(curator).approve(delegation, await lido.getPooledEthByShares(stakingVaultMaxMintingShares));
    await delegation.connect(curator).burnShares(stakingVaultMaxMintingShares);

    const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
    const vaultValue = await addRewards(elapsedVaultReward / 2n); // Half the vault rewards value after validator exit

    const params = {
      clDiff: elapsedProtocolReward,
      excludeVaultsBalances: true,
      vaultValues: [vaultValue],
      inOutDeltas: [VAULT_DEPOSIT],
    } as OracleReportParams;

    await report(ctx, params);

    const socket = await vaultHub["vaultSocket(address)"](stakingVaultAddress);
    const mintedShares = socket.sharesMinted;
    expect(mintedShares).to.be.gt(0n); // we still have the protocol fees minted

    const lockedOnVault = await stakingVault.locked();
    expect(lockedOnVault).to.be.gt(0n);
  });

  it("Should allow Manager to rebalance the vault to reduce the debt", async () => {
    const { vaultHub, lido } = ctx.contracts;

    const socket = await vaultHub["vaultSocket(address)"](stakingVaultAddress);
    const stETHToRebalance = await lido.getPooledEthByShares(socket.sharesMinted);

    await delegation.connect(curator).rebalanceVault(stETHToRebalance, { value: stETHToRebalance });

    expect(await stakingVault.locked()).to.equal(VAULT_CONNECTION_DEPOSIT); // 1 ETH locked as a connection fee
  });

  it("Should allow Manager to disconnect vaults from the hub", async () => {
    const disconnectTx = await delegation.connect(curator).voluntaryDisconnect();
    const disconnectTxReceipt = (await disconnectTx.wait()) as ContractTransactionReceipt;

    const disconnectEvents = ctx.getEvents(disconnectTxReceipt, "VaultDisconnected");
    expect(disconnectEvents.length).to.equal(1n);

    expect(await stakingVault.locked()).to.equal(0);
  });

  async function isSoleRoleMember(account: HardhatEthersSigner, role: string) {
    return (await delegation.getRoleMemberCount(role)).toString() === "1" && (await delegation.hasRole(role, account));
  }
});
