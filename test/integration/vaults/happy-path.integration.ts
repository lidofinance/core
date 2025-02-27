import { expect } from "chai";
import { ContractTransactionReceipt, hexlify, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault } from "typechain-types";

import { computeDepositDataRoot, days, ether, impersonate, log, updateBalance } from "lib";
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

const PUBKEY_LENGTH = 48n;
const SIGNATURE_LENGTH = 96n;

const LIDO_DEPOSIT = ether("640");

const VALIDATORS_PER_VAULT = 2n;
const VALIDATOR_DEPOSIT_SIZE = ether("32");
const VAULT_DEPOSIT = VALIDATOR_DEPOSIT_SIZE * VALIDATORS_PER_VAULT;

const ONE_YEAR = 365n * ONE_DAY;
const TARGET_APR = 3_00n; // 3% APR
const PROTOCOL_FEE = 10_00n; // 10% fee (5% treasury + 5% node operators)
const TOTAL_BASIS_POINTS = 100_00n; // 100%

const VAULT_CONNECTION_DEPOSIT = ether("1");
const VAULT_OWNER_FEE = 1_00n; // 1% AUM owner fee
const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee

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

  let pubKeysBatch: Uint8Array;
  let signaturesBatch: Uint8Array;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [ethHolder, owner, nodeOperator, curator] = await ethers.getSigners();

    const { depositSecurityModule } = ctx.contracts;
    depositContract = await depositSecurityModule.DEPOSIT_CONTRACT();

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

    expect(await _stakingVault.vaultHub()).to.equal(ctx.contracts.accounting.address);
    expect(await _stakingVault.DEPOSIT_CONTRACT()).to.equal(depositContract);
    expect(await _delegation.STETH()).to.equal(ctx.contracts.lido.address);

    // TODO: check what else should be validated here
  });

  it("Should allow Owner to create vault and assign Operator and Manager roles", async () => {
    const { stakingVaultFactory } = ctx.contracts;

    // Owner can create a vault with operator as a node operator
    const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
      {
        defaultAdmin: owner,
        nodeOperatorManager: nodeOperator,
        curatorFeeBP: VAULT_OWNER_FEE,
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
        curatorFeeSetters: [curator],
        curatorFeeClaimers: [curator],
        nodeOperatorFeeClaimers: [nodeOperator],
      },
      "0x",
    );

    const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    expect(createVaultEvents.length).to.equal(1n);

    stakingVault = await ethers.getContractAt("StakingVault", createVaultEvents[0].args?.vault);
    delegation = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);

    expect(await isSoleRoleMember(owner, await delegation.DEFAULT_ADMIN_ROLE())).to.be.true;

    expect(await isSoleRoleMember(curator, await delegation.CURATOR_FEE_SET_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await delegation.CURATOR_FEE_CLAIM_ROLE())).to.be.true;

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
    const { lido, accounting } = ctx.contracts;

    expect(await stakingVault.locked()).to.equal(0); // no ETH locked yet

    const votingSigner = await ctx.getSigner("voting");
    await lido.connect(votingSigner).setMaxExternalRatioBP(20_00n);

    // only equivalent of 10.0% of TVL can be minted as stETH on the vault
    const shareLimit = (await lido.getTotalShares()) / 10n; // 10% of total shares

    const agentSigner = await ctx.getSigner("agent");

    await accounting
      .connect(agentSigner)
      .connectVault(stakingVault, shareLimit, reserveRatio, rebalanceThreshold, treasuryFeeBP);

    expect(await accounting.vaultsCount()).to.equal(1n);
    expect(await stakingVault.locked()).to.equal(VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow Staker to fund vault via delegation contract", async () => {
    await delegation.connect(curator).fund({ value: VAULT_DEPOSIT });

    const vaultBalance = await ethers.provider.getBalance(stakingVault);

    expect(vaultBalance).to.equal(VAULT_DEPOSIT);
    expect(await stakingVault.valuation()).to.equal(VAULT_DEPOSIT);
  });

  it("Should allow Operator to deposit validators from the vault", async () => {
    const keysToAdd = VALIDATORS_PER_VAULT;
    pubKeysBatch = ethers.randomBytes(Number(keysToAdd * PUBKEY_LENGTH));
    signaturesBatch = ethers.randomBytes(Number(keysToAdd * SIGNATURE_LENGTH));

    const deposits = [];

    for (let i = 0; i < keysToAdd; i++) {
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const pubkey = hexlify(pubKeysBatch.slice(i * Number(PUBKEY_LENGTH), (i + 1) * Number(PUBKEY_LENGTH)));
      const signature = hexlify(
        signaturesBatch.slice(i * Number(SIGNATURE_LENGTH), (i + 1) * Number(SIGNATURE_LENGTH)),
      );

      deposits.push({
        pubkey: pubkey,
        signature: signature,
        amount: VALIDATOR_DEPOSIT_SIZE,
        depositDataRoot: computeDepositDataRoot(withdrawalCredentials, pubkey, signature, VALIDATOR_DEPOSIT_SIZE),
      });
    }

    await stakingVault.connect(nodeOperator).depositToBeaconChain(deposits);

    stakingVaultBeaconBalance += VAULT_DEPOSIT;
    stakingVaultAddress = await stakingVault.getAddress();

    const vaultBalance = await ethers.provider.getBalance(stakingVault);
    expect(vaultBalance).to.equal(0n);
    expect(await stakingVault.valuation()).to.equal(VAULT_DEPOSIT);
  });

  it("Should allow Token Master to mint max stETH", async () => {
    const { accounting, lido } = ctx.contracts;

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
      .to.be.revertedWithCustomError(accounting, "InsufficientValuationToMint")
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

  it("Should rebase simulating 3% APR", async () => {
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

    const errorReportingEvent = ctx.getEvents(reportTxReceipt, "OnReportFailed", [stakingVault.interface]);
    expect(errorReportingEvent.length).to.equal(0n);

    const vaultReportedEvent = ctx.getEvents(reportTxReceipt, "Reported", [stakingVault.interface]);
    expect(vaultReportedEvent.length).to.equal(1n);

    expect(vaultReportedEvent[0].args?.valuation).to.equal(vaultValue);
    expect(vaultReportedEvent[0].args?.inOutDelta).to.equal(VAULT_DEPOSIT);
    // TODO: add assertions or locked values and rewards

    expect(await delegation.curatorUnclaimedFee()).to.be.gt(0n);
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

  it("Should allow Owner to trigger validator exit to cover fees", async () => {
    // simulate validator exit
    const secondValidatorKey = pubKeysBatch.slice(Number(PUBKEY_LENGTH), Number(PUBKEY_LENGTH) * 2);
    await delegation.connect(curator).requestValidatorExit(secondValidatorKey);
    await updateBalance(stakingVaultAddress, VALIDATOR_DEPOSIT_SIZE);

    const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
    const vaultValue = await addRewards(elapsedVaultReward / 2n); // Half the vault rewards value to simulate the validator exit

    const params = {
      clDiff: elapsedProtocolReward,
      excludeVaultsBalances: true,
      vaultValues: [vaultValue],
      inOutDeltas: [VAULT_DEPOSIT],
    } as OracleReportParams;

    await report(ctx, params);
  });

  it("Should allow Manager to claim manager rewards in ETH after rebase with exited validator", async () => {
    const feesToClaim = await delegation.curatorUnclaimedFee();

    log.debug("Staking Vault stats after operator exit", {
      "Staking Vault management fee": ethers.formatEther(feesToClaim),
      "Staking Vault balance": ethers.formatEther(await ethers.provider.getBalance(stakingVaultAddress)),
    });

    const managerBalanceBefore = await ethers.provider.getBalance(curator);

    const claimEthTx = await delegation.connect(curator).claimCuratorFee(curator);
    const { gasUsed, gasPrice } = (await claimEthTx.wait()) as ContractTransactionReceipt;

    const managerBalanceAfter = await ethers.provider.getBalance(curator);
    const vaultBalance = await ethers.provider.getBalance(stakingVaultAddress);

    log.debug("Balances after owner fee claim", {
      "Manager's ETH balance before": ethers.formatEther(managerBalanceBefore),
      "Manager's ETH balance after": ethers.formatEther(managerBalanceAfter),
      "Manager's ETH balance diff": ethers.formatEther(managerBalanceAfter - managerBalanceBefore),
      "Staking Vault owner fee": ethers.formatEther(feesToClaim),
      "Staking Vault balance": ethers.formatEther(vaultBalance),
    });

    expect(managerBalanceAfter).to.equal(managerBalanceBefore + feesToClaim - gasUsed * gasPrice);
  });

  it("Should allow Token Master to burn shares to repay debt", async () => {
    const { lido } = ctx.contracts;

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

    const lockedOnVault = await stakingVault.locked();
    expect(lockedOnVault).to.be.gt(0n); // lockedOnVault should be greater than 0, because of the debt

    // TODO: add more checks here
  });

  it("Should allow Manager to rebalance the vault to reduce the debt", async () => {
    const { accounting, lido } = ctx.contracts;

    const socket = await accounting["vaultSocket(address)"](stakingVaultAddress);
    const sharesMinted = await lido.getPooledEthByShares(socket.sharesMinted);

    await delegation.connect(curator).rebalanceVault(sharesMinted, { value: sharesMinted });

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
