import { expect } from "chai";
import { ContractTransactionReceipt, hexlify } from "ethers";
import { ethers } from "hardhat";

import { SecretKey } from "@chainsafe/blst";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, SSZHelpers, StakingVault } from "typechain-types";

import {
  days,
  ether,
  generatePostDeposit,
  generatePredeposit,
  generateValidator,
  log,
  prepareLocalMerkleTree,
} from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { reportVaultDataWithProof } from "lib/protocol/helpers/vaults";

import { bailOnFailure, Snapshot } from "test/suite";

const VALIDATORS_PER_VAULT = 2n;
const VALIDATOR_DEPOSIT_SIZE = ether("32");
const VAULT_DEPOSIT = VALIDATOR_DEPOSIT_SIZE * VALIDATORS_PER_VAULT;

// const ONE_YEAR = 365n * ONE_DAY;
// const TARGET_APR = 3_00n; // 3% APR
// const PROTOCOL_FEE = 10_00n; // 10% fee (5% treasury + 5% node operators)
const TOTAL_BASIS_POINTS = 100_00n; // 100%

const VAULT_CONNECTION_DEPOSIT = ether("1");
const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator performance fee
const CONFIRM_EXPIRY = days(7n);

describe("Scenario: Staking Vaults Happy Path", () => {
  let ctx: ProtocolContext;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let curator: HardhatEthersSigner;
  let depositContract: string;

  const reserveRatio = 10_00n; // 10% of ETH allocation as reserve
  const forcedRebalanceThreshold = 8_00n; // 8% is a threshold to force rebalance on the vault
  const mintableRatio = TOTAL_BASIS_POINTS - reserveRatio; // 90% LTV

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let stakingVaultAddress: string;
  let stakingVaultBeaconBalance = 0n;
  let stakingVaultMaxMintingShares = 0n;

  const treasuryFeeBP = 5_00n; // 5% of the treasury fee

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [owner, nodeOperator, curator] = await ethers.getSigners();

    const { depositSecurityModule } = ctx.contracts;
    depositContract = await depositSecurityModule.DEPOSIT_CONTRACT();

    // add ETH to NO for PDG deposit + gas
    await setBalance(nodeOperator.address, ether((VALIDATORS_PER_VAULT + 1n).toString()));

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  beforeEach(bailOnFailure);

  // async function calculateReportParams() {
  //   const { beaconBalance } = await ctx.contracts.lido.getBeaconStat();
  //   const { timeElapsed } = await getReportTimeElapsed(ctx);

  //   log.debug("Report time elapsed", { timeElapsed });

  //   const gross = (TARGET_APR * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - PROTOCOL_FEE); // take into account 10% Lido fee
  //   const elapsedProtocolReward = (beaconBalance * gross * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;
  //   const elapsedVaultReward = (VAULT_DEPOSIT * gross * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;

  //   log.debug("Report values", {
  //     "Elapsed rewards": elapsedProtocolReward,
  //     "Elapsed vault rewards": elapsedVaultReward,
  //   });

  //   return { elapsedProtocolReward, elapsedVaultReward };
  // }

  // async function addRewards(rewards: bigint) {
  //   if (!stakingVaultAddress || !stakingVault) {
  //     throw new Error("Staking Vault is not initialized");
  //   }

  //   const vault101Balance = (await ethers.provider.getBalance(stakingVaultAddress)) + rewards;
  //   await updateBalance(stakingVaultAddress, vault101Balance);

  //   // Use beacon balance to calculate the vault value
  //   return vault101Balance + stakingVaultBeaconBalance;
  // }

  it("Should have vaults factory deployed and adopted by DAO", async () => {
    const { stakingVaultFactory, stakingVaultBeacon } = ctx.contracts;

    const implAddress = await stakingVaultBeacon.implementation();
    const dashboardAddress = await stakingVaultFactory.DASHBOARD_IMPL();
    const _stakingVault = await ethers.getContractAt("StakingVault", implAddress);
    const _dashboard = await ethers.getContractAt("Dashboard", dashboardAddress);

    expect(await _stakingVault.DEPOSIT_CONTRACT()).to.equal(depositContract);
    expect(await _dashboard.STETH()).to.equal(ctx.contracts.lido.address);

    // TODO: check what else should be validated here
  });

  it("Should allow Owner to create vault and assign NodeOperator and Curator roles", async () => {
    const { lido, stakingVaultFactory, operatorGrid } = ctx.contracts;

    // only equivalent of 10.0% of TVL can be minted as stETH on the vault
    const shareLimit = (await lido.getTotalShares()) / 10n; // 10% of total shares

    const agentSigner = await ctx.getSigner("agent");

    const defaultGroupId = await operatorGrid.DEFAULT_TIER_ID();
    await operatorGrid.connect(agentSigner).alterTier(defaultGroupId, {
      shareLimit,
      reserveRatioBP: reserveRatio,
      forcedRebalanceThresholdBP: forcedRebalanceThreshold,
      treasuryFeeBP: treasuryFeeBP,
    });

    // Owner can create a vault with operator as a node operator
    const deployTx = await stakingVaultFactory
      .connect(owner)
      .createVaultWithDashboard(owner, nodeOperator, nodeOperator, VAULT_NODE_OPERATOR_FEE, CONFIRM_EXPIRY, [], "0x", {
        value: VAULT_CONNECTION_DEPOSIT,
      });

    const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    expect(createVaultEvents.length).to.equal(1n);

    stakingVault = await ethers.getContractAt("StakingVault", createVaultEvents[0].args?.vault);
    dashboard = await ethers.getContractAt("Dashboard", createVaultEvents[0].args?.owner);

    await dashboard.connect(owner).grantRoles([
      {
        role: await dashboard.FUND_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.WITHDRAW_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.LOCK_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.MINT_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.BURN_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.REBALANCE_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.REQUEST_VALIDATOR_EXIT_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
        account: curator,
      },
      {
        role: await dashboard.VOLUNTARY_DISCONNECT_ROLE(),
        account: curator,
      },
    ]);

    await dashboard.connect(nodeOperator).grantRole(await dashboard.NODE_OPERATOR_FEE_CLAIM_ROLE(), nodeOperator);

    expect(await isSoleRoleMember(owner, await dashboard.DEFAULT_ADMIN_ROLE())).to.be.true;

    expect(await isSoleRoleMember(nodeOperator, await dashboard.NODE_OPERATOR_MANAGER_ROLE())).to.be.true;
    expect(await isSoleRoleMember(nodeOperator, await dashboard.NODE_OPERATOR_FEE_CLAIM_ROLE())).to.be.true;

    expect(await isSoleRoleMember(curator, await dashboard.FUND_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.WITHDRAW_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.LOCK_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.MINT_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.BURN_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.REBALANCE_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.REQUEST_VALIDATOR_EXIT_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE())).to.be.true;
    expect(await isSoleRoleMember(curator, await dashboard.VOLUNTARY_DISCONNECT_ROLE())).to.be.true;
  });

  it("Should allow Lido to recognize vaults and connect them to accounting", async () => {
    const { lido, vaultHub } = ctx.contracts;

    expect(await stakingVault.locked()).to.equal(ether("1")); // has locked value cause of connection deposit

    const votingSigner = await ctx.getSigner("voting");
    await lido.connect(votingSigner).setMaxExternalRatioBP(20_00n);

    expect(await vaultHub.vaultsCount()).to.equal(1n);
    expect(await stakingVault.locked()).to.equal(VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow Curator to fund vault via dashboard contract", async () => {
    await dashboard.connect(curator).fund({ value: VAULT_DEPOSIT });

    const vaultBalance = await ethers.provider.getBalance(stakingVault);

    expect(vaultBalance).to.equal(VAULT_DEPOSIT + VAULT_CONNECTION_DEPOSIT);
    expect(await stakingVault.totalValue()).to.equal(VAULT_DEPOSIT + VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow NodeOperator to deposit validators from the vault via PDG", async () => {
    const keysToAdd = VALIDATORS_PER_VAULT;

    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const predepositAmount = await ctx.contracts.predepositGuarantee.PREDEPOSIT_AMOUNT();
    const depositDomain = await ctx.contracts.predepositGuarantee.DEPOSIT_DOMAIN();

    const validators: {
      container: SSZHelpers.ValidatorStruct;
      blsPrivateKey: SecretKey;
      index: number;
      proof: string[];
    }[] = [];

    for (let i = 0; i < keysToAdd; i++) {
      validators.push({ ...generateValidator(withdrawalCredentials), index: 0, proof: [] });
    }

    const predeposits = await Promise.all(
      validators.map((validator) => {
        return generatePredeposit(validator, { depositDomain });
      }),
    );

    const pdg = ctx.contracts.predepositGuarantee.connect(nodeOperator);

    // top up PDG balance
    await pdg.topUpNodeOperatorBalance(nodeOperator, { value: ether(VALIDATORS_PER_VAULT.toString()) });

    // predeposit validators
    await pdg.predeposit(
      stakingVault,
      predeposits.map((p) => p.deposit),
      predeposits.map((p) => p.depositY),
    );

    const slot = await pdg.PIVOT_SLOT();

    const mockCLtree = await prepareLocalMerkleTree(await pdg.GI_FIRST_VALIDATOR_CURR());

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
      slot: beaconBlockHeader.slot,
      proposerIndex: beaconBlockHeader.proposerIndex,
    }));

    const postDepositAmount = VALIDATOR_DEPOSIT_SIZE - predepositAmount;
    const postdeposits = validators.map((validator) => {
      return generatePostDeposit(validator.container, postDepositAmount);
    });

    await pdg.proveAndDeposit(witnesses, postdeposits, stakingVault);

    stakingVaultBeaconBalance += VAULT_DEPOSIT;
    stakingVaultBeaconBalance;
    stakingVaultAddress = await stakingVault.getAddress();

    const vaultBalance = await ethers.provider.getBalance(stakingVault);
    expect(vaultBalance).to.equal(VAULT_CONNECTION_DEPOSIT);
    expect(await stakingVault.totalValue()).to.equal(VAULT_DEPOSIT + VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow Curator to mint max stETH", async () => {
    const { lido } = ctx.contracts;

    // Calculate the max stETH that can be minted on the vault 101 with the given LTV
    stakingVaultMaxMintingShares = await lido.getSharesByPooledEth(
      (VAULT_DEPOSIT * mintableRatio) / TOTAL_BASIS_POINTS,
    );

    log.debug("Staking Vault", {
      "Staking Vault Address": stakingVaultAddress,
      "Total ETH": await stakingVault.totalValue(),
      "Max shares": stakingVaultMaxMintingShares,
    });

    //report
    await reportVaultDataWithProof(stakingVault);

    // mint
    const mintTx = await dashboard.connect(curator).mintShares(curator, stakingVaultMaxMintingShares);
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

  // TODO: removed test as fees is 0 at the moment
  // it("Should rebase simulating 3% stETH APR", async () => {
  //   const { vaultHub } = ctx.contracts;

  //   const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
  //   const vaultValue = await addRewards(elapsedVaultReward);

  //   const params = {
  //     clDiff: elapsedProtocolReward,
  //     excludeVaultsBalances: true,
  //     vaultsTotalTreasuryFeesShares: vaultValue,
  //   } as OracleReportParams;

  //   const { reportTx } = (await report(ctx, params)) as {
  //     reportTx: TransactionResponse;
  //     extraDataTx: TransactionResponse;
  //   };
  //   const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

  //   const socket = await vaultHub["vaultSocket(address)"](stakingVaultAddress);
  //   expect(socket.liabilityShares).to.be.gt(stakingVaultMaxMintingShares);

  //   const vaultReportedEvent = ctx.getEvents(reportTxReceipt, "Reported", [stakingVault.interface]);
  //   expect(vaultReportedEvent.length).to.equal(1n);

  //   expect(vaultReportedEvent[0].args?.totalValue).to.equal(vaultValue);
  //   expect(vaultReportedEvent[0].args?.inOutDelta).to.equal(VAULT_DEPOSIT);
  //   // TODO: add assertions or locked values and rewards

  //   expect(await delegation.nodeOperatorUnclaimedFee()).to.be.gt(0n);
  // });

  // it("Should allow Operator to claim performance fees", async () => {
  //   const performanceFee = await delegation.nodeOperatorUnclaimedFee();
  //   log.debug("Staking Vault stats", {
  //     "Staking Vault performance fee": ethers.formatEther(performanceFee),
  //   });

  //   const operatorBalanceBefore = await ethers.provider.getBalance(nodeOperator);

  //   const claimPerformanceFeesTx = await delegation.connect(nodeOperator).claimNodeOperatorFee(nodeOperator);
  //   const claimPerformanceFeesTxReceipt = (await claimPerformanceFeesTx.wait()) as ContractTransactionReceipt;

  //   const operatorBalanceAfter = await ethers.provider.getBalance(nodeOperator);
  //   const gasFee = claimPerformanceFeesTxReceipt.gasPrice * claimPerformanceFeesTxReceipt.cumulativeGasUsed;

  //   log.debug("Operator's StETH balance", {
  //     "Balance before": ethers.formatEther(operatorBalanceBefore),
  //     "Balance after": ethers.formatEther(operatorBalanceAfter),
  //     "Gas used": claimPerformanceFeesTxReceipt.cumulativeGasUsed,
  //     "Gas fees": ethers.formatEther(gasFee),
  //   });

  //   expect(operatorBalanceAfter).to.equal(operatorBalanceBefore + performanceFee - gasFee);
  // });

  // it("Should allow Curator to burn minted shares", async () => {
  //   const { lido, vaultHub } = ctx.contracts;

  //   // Token master can approve the vault to burn the shares
  //   await lido.connect(curator).approve(delegation, await lido.getPooledEthByShares(stakingVaultMaxMintingShares));
  //   await delegation.connect(curator).burnShares(stakingVaultMaxMintingShares);

  //   const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
  //   const vaultValue = await addRewards(elapsedVaultReward / 2n); // Half the vault rewards value after validator exit

  //   const params = {
  //     clDiff: elapsedProtocolReward,
  //     excludeVaultsBalances: true,
  //     vaultValues: [vaultValue],
  //     inOutDeltas: [VAULT_DEPOSIT],
  //   } as OracleReportParams;

  //   await report(ctx, params);

  //   const socket = await vaultHub["vaultSocket(address)"](stakingVaultAddress);
  //   const mintedShares = socket.liabilityShares;
  //   expect(mintedShares).to.be.gt(0n); // we still have the protocol fees minted

  //   const lockedOnVault = await stakingVault.locked();
  //   expect(lockedOnVault).to.be.gt(0n);
  // });

  // it("Should allow Manager to rebalance the vault to reduce the debt", async () => {
  //   const { vaultHub, lido } = ctx.contracts;

  //   const socket = await vaultHub["vaultSocket(address)"](stakingVaultAddress);
  //   const stETHToRebalance = await lido.getPooledEthByShares(socket.liabilityShares);

  //   await delegation.connect(curator).rebalanceVault(stETHToRebalance, { value: stETHToRebalance });

  //   expect(await stakingVault.locked()).to.equal(VAULT_CONNECTION_DEPOSIT); // 1 ETH locked as a connection fee
  // });

  // it("Should allow Manager to disconnect vaults from the hub", async () => {
  //   const disconnectTx = await delegation.connect(curator).voluntaryDisconnect();
  //   const disconnectTxReceipt = (await disconnectTx.wait()) as ContractTransactionReceipt;

  //   const disconnectEvents = ctx.getEvents(disconnectTxReceipt, "VaultDisconnected");
  //   expect(disconnectEvents.length).to.equal(1n);

  //   expect(await stakingVault.locked()).to.equal(0);
  // });

  async function isSoleRoleMember(account: HardhatEthersSigner, role: string) {
    return (await dashboard.getRoleMemberCount(role)).toString() === "1" && (await dashboard.hasRole(role, account));
  }
});
