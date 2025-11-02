import { expect } from "chai";
import { ContractTransactionReceipt, hexlify } from "ethers";
import { ethers } from "hardhat";

import { SecretKey } from "@chainsafe/blst";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, SSZBLSHelpers, StakingVault } from "typechain-types";

import {
  days,
  ether,
  generatePredeposit,
  generateTopUp,
  generateValidator,
  log,
  prepareLocalMerkleTree,
  updateBalance,
} from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";
import {
  calculateLockedValue,
  getProtocolContext,
  getReportTimeElapsed,
  OracleReportParams,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";
import { ONE_DAY } from "test/suite/constants";

const VALIDATORS_PER_VAULT = 2n;
const VALIDATOR_DEPOSIT_SIZE = ether("33");
const VAULT_DEPOSIT = VALIDATOR_DEPOSIT_SIZE * VALIDATORS_PER_VAULT;

const ONE_YEAR = 365n * ONE_DAY;
const TARGET_APR = 3_00n; // 3% APR
const PROTOCOL_FEE = 10_00n; // 10% fee (5% treasury + 5% node operators)

const INFRA_FEE_BP = 5_00n;
const LIQUIDITY_FEE_BP = 4_00n;
const RESERVATION_FEE_BP = 1_00n;

const VAULT_CONNECTION_DEPOSIT = ether("1");
const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator performance fee
const CONFIRM_EXPIRY = days(7n);

describe("Scenario: Staking Vaults Happy Path", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let depositContract: string;

  const reserveRatio = 10_00n; // 10% of ETH allocation as reserve
  const forcedRebalanceThreshold = 8_00n; // 8% is a threshold to force rebalance on the vault
  const mintableRatio = TOTAL_BASIS_POINTS - reserveRatio; // 90% LTV

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let stakingVaultAddress: string;
  let stakingVaultCLBalance = 0n;
  let stakingVaultMaxMintingShares = 0n;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [, owner, nodeOperator] = await ethers.getSigners();

    const { depositSecurityModule } = ctx.contracts;
    depositContract = await depositSecurityModule.DEPOSIT_CONTRACT();

    await setupLidoForVaults(ctx);

    // add ETH to NO for PDG deposit + gas
    await setBalance(nodeOperator.address, ether((VALIDATORS_PER_VAULT + 1n).toString()));
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
    if (!stakingVault) {
      throw new Error("Staking Vault is not initialized");
    }

    const vault101Balance = (await ethers.provider.getBalance(stakingVaultAddress)) + rewards;
    await updateBalance(stakingVaultAddress, vault101Balance);

    // Use beacon balance to calculate the vault value
    return vault101Balance + stakingVaultCLBalance;
  }

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

  it("Should allow Owner to create vault and assign NodeOperator", async () => {
    const { lido, stakingVaultFactory, operatorGrid } = ctx.contracts;

    // only equivalent of 10.0% of TVL can be minted as stETH on the vault
    const shareLimit = (await lido.getTotalShares()) / 10n; // 10% of total shares

    const agentSigner = await ctx.getSigner("agent");

    const defaultGroupId = await operatorGrid.DEFAULT_TIER_ID();
    await operatorGrid.connect(agentSigner).alterTiers(
      [defaultGroupId],
      [
        {
          shareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: INFRA_FEE_BP,
          liquidityFeeBP: LIQUIDITY_FEE_BP,
          reservationFeeBP: RESERVATION_FEE_BP,
        },
      ],
    );

    // Owner can create a vault with operator as a node operator
    const deployTx = await stakingVaultFactory
      .connect(owner)
      .createVaultWithDashboard(owner, nodeOperator, nodeOperator, VAULT_NODE_OPERATOR_FEE, CONFIRM_EXPIRY, [], {
        value: VAULT_CONNECTION_DEPOSIT,
      });

    const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");
    expect(createVaultEvents.length).to.equal(1n);

    stakingVaultAddress = createVaultEvents[0].args?.vault;

    stakingVault = await ethers.getContractAt("StakingVault", stakingVaultAddress);
    const createDashboardEvents = ctx.getEvents(createVaultTxReceipt, "DashboardCreated");
    expect(createDashboardEvents.length).to.equal(1n);
    dashboard = await ethers.getContractAt("Dashboard", createDashboardEvents[0].args?.dashboard);

    expect(await isSoleRoleMember(owner, await dashboard.DEFAULT_ADMIN_ROLE())).to.be.true;

    expect(await isSoleRoleMember(nodeOperator, await dashboard.NODE_OPERATOR_MANAGER_ROLE())).to.be.true;
  });

  it("Should allow Lido to recognize vaults and connect them to accounting", async () => {
    const { vaultHub } = ctx.contracts;

    expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("1")); // has locked value cause of connection deposit

    expect(await vaultHub.vaultsCount()).to.equal(1n);
    expect(await vaultHub.locked(stakingVaultAddress)).to.equal(VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow Owner to fund vault via dashboard contract", async () => {
    const { vaultHub } = ctx.contracts;

    await dashboard.connect(owner).fund({ value: VAULT_DEPOSIT });

    const vaultBalance = await ethers.provider.getBalance(stakingVault);

    expect(vaultBalance).to.equal(VAULT_DEPOSIT + VAULT_CONNECTION_DEPOSIT);
    expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(VAULT_DEPOSIT + VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow NodeOperator to deposit validators from the vault via PDG", async () => {
    const { predepositGuarantee, vaultHub } = ctx.contracts;
    const keysToAdd = VALIDATORS_PER_VAULT;

    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const predepositAmount = await predepositGuarantee.PREDEPOSIT_AMOUNT();
    const depositDomain = await predepositGuarantee.DEPOSIT_DOMAIN();

    const validators: {
      container: SSZBLSHelpers.ValidatorStruct;
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

    const pdg = predepositGuarantee.connect(nodeOperator);

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

    const postDepositAmount = VALIDATOR_DEPOSIT_SIZE - predepositAmount - ether("31");
    const postdeposits = validators.map((validator) => {
      return generateTopUp(validator.container, postDepositAmount);
    });

    await pdg.proveWCActivateAndTopUpValidators(
      witnesses,
      postdeposits.map((p) => p.amount),
    );

    stakingVaultCLBalance += VAULT_DEPOSIT;

    const vaultBalance = await ethers.provider.getBalance(stakingVault);
    expect(vaultBalance).to.equal(VAULT_CONNECTION_DEPOSIT);
    expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(VAULT_DEPOSIT + VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow Owner to mint max stETH", async () => {
    const { lido, vaultHub } = ctx.contracts;

    // Calculate the max stETH that can be minted on the vault 101 with the given LTV
    const funding = VAULT_DEPOSIT + VAULT_CONNECTION_DEPOSIT;
    const maxMintableStETH = (funding * mintableRatio) / TOTAL_BASIS_POINTS;
    stakingVaultMaxMintingShares = await lido.getSharesByPooledEth(maxMintableStETH);

    const maxMintableShares = await dashboard.totalMintingCapacityShares();
    expect(maxMintableShares).to.equal(stakingVaultMaxMintingShares);

    const maxLockableValue = await vaultHub.maxLockableValue(stakingVaultAddress);
    expect(maxLockableValue).to.equal(funding);

    log.debug("Staking Vault", {
      "Staking Vault Address": stakingVaultAddress,
      "Total ETH": await vaultHub.totalValue(stakingVaultAddress),
      "Max shares": stakingVaultMaxMintingShares,
    });

    //report
    await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

    // mint
    const lockedBefore = await vaultHub.locked(stakingVaultAddress);
    expect(lockedBefore).to.equal(VAULT_CONNECTION_DEPOSIT); // minimal reserve

    await expect(dashboard.connect(owner).mintShares(owner, stakingVaultMaxMintingShares))
      .to.emit(vaultHub, "MintedSharesOnVault")
      .withArgs(
        stakingVaultAddress,
        stakingVaultMaxMintingShares,
        await calculateLockedValue(ctx, stakingVault, { liabilityShares: stakingVaultMaxMintingShares }),
      );

    expect(await dashboard.remainingMintingCapacityShares(0n)).to.equal(0n);
  });

  it("Should rebase simulating 3% stETH APR", async () => {
    const { vaultHub } = ctx.contracts;

    const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
    const vaultValue = await addRewards(elapsedVaultReward);

    const params = {
      clDiff: elapsedProtocolReward,
      excludeVaultsBalances: true,
    } as OracleReportParams;

    await report(ctx, params);

    expect(await vaultHub.liabilityShares(stakingVaultAddress)).to.be.equal(stakingVaultMaxMintingShares);

    const reportResponse = await reportVaultDataWithProof(ctx, stakingVault, { totalValue: vaultValue });
    const reportTxReceipt = (await reportResponse.wait()) as ContractTransactionReceipt;
    const vaultReportedEvents = ctx.getEvents(reportTxReceipt, "VaultReportApplied", [vaultHub.interface]);
    expect(vaultReportedEvents.length).to.equal(1n);

    const vaultReportedEvent = vaultReportedEvents[0];
    expect(vaultReportedEvent.args?.vault).to.equal(stakingVaultAddress);
    // todo: check timestamp
    expect(vaultReportedEvent.args?.reportTotalValue).to.equal(vaultValue);
    expect(vaultReportedEvent.args?.reportInOutDelta).to.equal(VAULT_CONNECTION_DEPOSIT + VAULT_DEPOSIT);
    expect(vaultReportedEvent.args?.reportLiabilityShares).to.equal(stakingVaultMaxMintingShares);
    // TODO: add assertions for fees

    expect(await dashboard.accruedFee()).to.be.gt(0n);
  });

  it("Should allow Operator to claim performance fees", async () => {
    const performanceFee = await dashboard.accruedFee();
    log.debug("Staking Vault stats", {
      "Staking Vault performance fee": ethers.formatEther(performanceFee),
    });

    const operatorBalanceBefore = await ethers.provider.getBalance(nodeOperator);

    const claimPerformanceFeesTx = await dashboard.connect(nodeOperator).disburseFee();
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

  it("Should allow Owner to burn minted shares", async () => {
    const { lido, vaultHub } = ctx.contracts;

    // Token master can approve the vault to burn the shares
    await lido.connect(owner).approve(dashboard, await lido.getPooledEthByShares(stakingVaultMaxMintingShares));
    await dashboard.connect(owner).burnShares(stakingVaultMaxMintingShares);

    const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
    const vaultValue = await addRewards(elapsedVaultReward / 2n); // Half the vault rewards value after validator exit

    const params = {
      clDiff: elapsedProtocolReward,
      excludeVaultsBalances: true,
    } as OracleReportParams;

    await report(ctx, params);

    await reportVaultDataWithProof(ctx, stakingVault, { totalValue: vaultValue });

    const mintedShares = await vaultHub.liabilityShares(stakingVaultAddress);
    expect(mintedShares).to.be.equal(0n); // it's zero because protocol fees deducted not in shares

    const lockedOnVault = await vaultHub.locked(stakingVaultAddress);
    expect(lockedOnVault).to.be.gt(0);
  });

  it("Should allow Owner to rebalance the vault to reduce the debt", async () => {
    const { vaultHub } = ctx.contracts;

    await dashboard.connect(owner).mintShares(owner, 10n);

    const sharesToRebalance = await vaultHub.liabilityShares(stakingVaultAddress);

    // Top-up and rebalance the vault
    await dashboard.connect(owner).rebalanceVaultWithShares(sharesToRebalance);

    await reportVaultDataWithProof(ctx, stakingVault);

    expect(await vaultHub.locked(stakingVaultAddress)).to.equal(VAULT_CONNECTION_DEPOSIT); // 1 ETH locked as a connection fee
  });

  it("Should allow Owner to disconnect vaults from the hub", async () => {
    const { vaultHub } = ctx.contracts;

    const disconnectTx = await dashboard.connect(owner).voluntaryDisconnect();
    const disconnectTxReceipt = (await disconnectTx.wait()) as ContractTransactionReceipt;

    const disconnectEvents = ctx.getEvents(disconnectTxReceipt, "VaultDisconnectInitiated");
    expect(disconnectEvents.length).to.equal(1n);

    const reportTxReceipt = await reportVaultDataWithProof(ctx, stakingVault);
    const reportTx = (await reportTxReceipt.wait()) as ContractTransactionReceipt;
    const reportEvents = ctx.getEvents(reportTx, "VaultDisconnectCompleted", [stakingVault.interface]);
    expect(reportEvents.length).to.equal(1n);

    expect(await vaultHub.locked(stakingVaultAddress)).to.equal(0);
  });

  async function isSoleRoleMember(account: HardhatEthersSigner, role: string) {
    return (await dashboard.getRoleMemberCount(role)).toString() === "1" && (await dashboard.hasRole(role, account));
  }
});
