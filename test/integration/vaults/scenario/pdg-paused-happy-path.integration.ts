import { expect } from "chai";
import { ContractTransactionReceipt, hexlify } from "ethers";
import { ethers } from "hardhat";

import { SecretKey } from "@chainsafe/blst";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard,
  LazyOracle,
  Lido,
  OperatorGrid,
  PredepositGuarantee,
  SSZBLSHelpers,
  StakingVault,
  VaultFactory,
  VaultHub,
} from "typechain-types";
import { TierParamsStruct } from "typechain-types/contracts/0.8.25/vaults/OperatorGrid";

import {
  advanceChainTime,
  days,
  ether,
  generateDepositStruct,
  generatePredeposit,
  generateValidator,
  LocalMerkleTree,
  PDGPolicy,
  prepareLocalMerkleTree,
} from "lib";
import { mEqual } from "lib/promise";
import {
  createVaultProxyWithoutConnectingToVaultHub,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  VAULT_CONNECTION_DEPOSIT,
} from "lib/protocol";

import { resetState, Snapshot } from "test/suite";

const VAULT_NODE_OPERATOR_FEE = 5_00n;
const CONFIRM_EXPIRY = days(7n);

const OPERATOR_GROUP_SHARE_LIMIT = ether("1500");
const OPERATOR_GROUP_INFRA_FEE_BP = 1_00n;
const OPERATOR_GROUP_LIQUIDITY_FEE_BP = 6_00n;
const OPERATOR_GROUP_RESERVATION_FEE_BP = 50n;

let OPERATOR_GROUP_TIER_1_ID: bigint;
const OPERATOR_GROUP_TIER_1_PARAMS: TierParamsStruct = {
  shareLimit: ether("1000"),
  reserveRatioBP: 10_00n,
  forcedRebalanceThresholdBP: 9_75n,
  infraFeeBP: OPERATOR_GROUP_INFRA_FEE_BP,
  liquidityFeeBP: OPERATOR_GROUP_LIQUIDITY_FEE_BP,
  reservationFeeBP: OPERATOR_GROUP_RESERVATION_FEE_BP,
};

let OPERATOR_GROUP_TIER_2_ID: bigint;
const OPERATOR_GROUP_TIER_2_PARAMS: TierParamsStruct = {
  shareLimit: ether("1500"),
  reserveRatioBP: 15_00n,
  forcedRebalanceThresholdBP: 14_75n,
  infraFeeBP: OPERATOR_GROUP_INFRA_FEE_BP,
  liquidityFeeBP: OPERATOR_GROUP_LIQUIDITY_FEE_BP,
  reservationFeeBP: OPERATOR_GROUP_RESERVATION_FEE_BP,
};

type ValidatorInfo = {
  container: SSZBLSHelpers.ValidatorStruct;
  blsPrivateKey: SecretKey;
  index: number;
  proof: string[];
};

resetState(
  describe("Scenario: Vault Happy Path with PDG Paused (Unguaranteed & Side Deposits)", () => {
    let ctx: ProtocolContext;

    // EOAs
    let vaultOwner: HardhatEthersSigner;
    let nodeOperator: HardhatEthersSigner;
    let nodeOperatorManager: HardhatEthersSigner;
    let stranger: HardhatEthersSigner;
    let agent: HardhatEthersSigner;

    // Protocol
    let vaultHub: VaultHub;
    let operatorGrid: OperatorGrid;
    let predepositGuarantee: PredepositGuarantee;
    let stakingVaultFactory: VaultFactory;
    let lazyOracle: LazyOracle;
    let lido: Lido;

    // Vault
    let stakingVault: StakingVault;
    let dashboard: Dashboard;
    let vaultTotalValue = 0n;
    let withdrawalCredentials: string;

    // Deposits
    let mockCLtree: LocalMerkleTree | undefined;
    let slot: bigint;
    let childBlockTimestamp: number;
    let beaconBlockHeader: SSZBLSHelpers.BeaconBlockHeaderStruct;
    const minActiveValidatorBalance = ether("32");

    // Validators
    const unguaranteedValidators: ValidatorInfo[] = [];
    const sideDepositedValidators: ValidatorInfo[] = [];

    const fundAmount = ether("200");

    before(async () => {
      [, vaultOwner, nodeOperator, nodeOperatorManager, stranger] = await ethers.getSigners();

      ctx = await getProtocolContext();
      ({ vaultHub, operatorGrid, predepositGuarantee, stakingVaultFactory, lido, lazyOracle } = ctx.contracts);

      agent = await ctx.getSigner("agent");

      await setupLidoForVaults(ctx);
      await setBalance(nodeOperator.address, ether("100"));

      // Pause PDG before any tests
      await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.PAUSE_ROLE(), agent);
      await predepositGuarantee.connect(agent).pauseFor(await predepositGuarantee.PAUSE_INFINITELY());
      expect(await predepositGuarantee.isPaused()).to.equal(true);

      slot = await predepositGuarantee.PIVOT_SLOT();
      mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_CURR());
    });

    // ==================== Part 1: Vault Creation and Connection ====================

    it("creates vault with immediate connection via createVaultWithDashboard (one-step)", async () => {
      // Snapshot before one-step creation
      const snapshotBeforeOneStepCreation = await Snapshot.take();

      // Register operator group and tiers first (needed for connection)
      await operatorGrid.connect(agent).registerGroup(nodeOperator, OPERATOR_GROUP_SHARE_LIMIT);
      await operatorGrid
        .connect(agent)
        .registerTiers(nodeOperator, [OPERATOR_GROUP_TIER_1_PARAMS, OPERATOR_GROUP_TIER_2_PARAMS]);

      // Prepare tier for vault
      const createTx = await stakingVaultFactory
        .connect(vaultOwner)
        .createVaultWithDashboard(
          vaultOwner,
          nodeOperator,
          nodeOperatorManager,
          VAULT_NODE_OPERATOR_FEE,
          CONFIRM_EXPIRY,
          [],
          {
            value: VAULT_CONNECTION_DEPOSIT,
          },
        );

      const createTxReceipt = (await createTx.wait()) as ContractTransactionReceipt;
      const vaultCreatedEvents = ctx.getEvents(createTxReceipt, "VaultCreated");
      expect(vaultCreatedEvents.length).to.equal(1n);

      const createdVaultAddress = vaultCreatedEvents[0].args?.vault;
      const createdVault = await ethers.getContractAt("StakingVault", createdVaultAddress);

      const dashboardCreatedEvents = ctx.getEvents(createTxReceipt, "DashboardCreated");
      expect(dashboardCreatedEvents.length).to.equal(1n);
      const createdDashboard = await ethers.getContractAt("Dashboard", dashboardCreatedEvents[0].args?.dashboard);

      // Verify vault is immediately connected
      await mEqual([
        [vaultHub.isVaultConnected(createdVault), true],
        [createdVault.nodeOperator(), nodeOperator],
        [createdVault.owner(), vaultHub], // VaultHub owns connected vaults
        [createdVault.depositor(), predepositGuarantee],
        [createdDashboard.hasRole(await createdDashboard.DEFAULT_ADMIN_ROLE(), vaultOwner), true],
        [createdDashboard.hasRole(await createdDashboard.NODE_OPERATOR_MANAGER_ROLE(), nodeOperatorManager), true],
        [createdDashboard.feeRecipient(), nodeOperatorManager],
        [createdDashboard.feeRate(), VAULT_NODE_OPERATOR_FEE],
        [createdDashboard.settledGrowth(), 0n],
        [createdDashboard.latestCorrectionTimestamp(), 0n],
        [createdDashboard.accruedFee(), 0n],
        [createdDashboard.feeLeftover(), 0n],
        [createdDashboard.pdgPolicy(), PDGPolicy.STRICT],
      ]);

      // Revert to continue with two-step connection path
      await Snapshot.restore(snapshotBeforeOneStepCreation);
    });

    it("creates a StakingVault and Dashboard (two-step path)", async () => {
      ({ vault: stakingVault, dashboard } = await createVaultProxyWithoutConnectingToVaultHub(
        nodeOperator,
        stakingVaultFactory,
        vaultOwner,
        nodeOperator,
        nodeOperatorManager,
        VAULT_NODE_OPERATOR_FEE,
        CONFIRM_EXPIRY,
      ));
      withdrawalCredentials = await stakingVault.withdrawalCredentials();

      await mEqual([
        // Vault state
        [stakingVaultFactory.deployedVaults(stakingVault), true],
        [vaultHub.isVaultConnected(stakingVault), false],
        [stakingVault.nodeOperator(), nodeOperator],
        [stakingVault.owner(), dashboard],
        [stakingVault.depositor(), predepositGuarantee],
        // Dashboard roles
        [dashboard.hasRole(await dashboard.DEFAULT_ADMIN_ROLE(), vaultOwner), true],
        [dashboard.hasRole(await dashboard.NODE_OPERATOR_MANAGER_ROLE(), nodeOperatorManager), true],
        // PDG and fee state
        [dashboard.pdgPolicy(), PDGPolicy.STRICT],
        [dashboard.feeRate(), VAULT_NODE_OPERATOR_FEE],
        [dashboard.feeRecipient(), nodeOperatorManager],
        [dashboard.settledGrowth(), 0n],
        [dashboard.accruedFee(), 0n],
        [dashboard.feeLeftover(), 0n],
        [dashboard.latestCorrectionTimestamp(), 0n],
      ]);
    });

    it("registers operator group", async () => {
      await operatorGrid.connect(agent).registerGroup(nodeOperator, OPERATOR_GROUP_SHARE_LIMIT);

      const registeredGroup = await operatorGrid.group(nodeOperator);
      await mEqual([
        [registeredGroup.operator, nodeOperator],
        [registeredGroup.shareLimit, OPERATOR_GROUP_SHARE_LIMIT],
        [registeredGroup.tierIds.length, 0],
      ]);
    });

    it("registers tiers", async () => {
      await operatorGrid
        .connect(agent)
        .registerTiers(nodeOperator, [OPERATOR_GROUP_TIER_1_PARAMS, OPERATOR_GROUP_TIER_2_PARAMS]);

      const group = await operatorGrid.group(nodeOperator);
      await mEqual([
        [group.tierIds.length, 2],
        [group.shareLimit, OPERATOR_GROUP_SHARE_LIMIT],
      ]);

      OPERATOR_GROUP_TIER_1_ID = group.tierIds[0];
      OPERATOR_GROUP_TIER_2_ID = group.tierIds[1];
    });

    it("connects to VaultHub with tier", async () => {
      await operatorGrid
        .connect(nodeOperator)
        .changeTier(stakingVault, OPERATOR_GROUP_TIER_1_ID, OPERATOR_GROUP_TIER_1_PARAMS.shareLimit);

      await dashboard
        .connect(vaultOwner)
        .connectAndAcceptTier(OPERATOR_GROUP_TIER_1_ID, OPERATOR_GROUP_TIER_1_PARAMS.shareLimit, {
          value: VAULT_CONNECTION_DEPOSIT,
        });

      vaultTotalValue += VAULT_CONNECTION_DEPOSIT;

      // Verify vault connection state
      const connection = await vaultHub.vaultConnection(stakingVault);
      const [, tierId, tierShareLimit] = await operatorGrid.vaultTierInfo(stakingVault);

      await mEqual([
        // Connection state
        [vaultHub.isVaultConnected(stakingVault), true],
        [vaultHub.isVaultHealthy(stakingVault), true],
        [vaultHub.totalValue(stakingVault), vaultTotalValue],
        [currentInOutDelta(stakingVault), vaultTotalValue],
        [vaultHub.locked(stakingVault), VAULT_CONNECTION_DEPOSIT],
        [vaultHub.liabilityShares(stakingVault), 0n],
        // Tier info
        [tierId, OPERATOR_GROUP_TIER_1_ID],
        [tierShareLimit, OPERATOR_GROUP_TIER_1_PARAMS.shareLimit],
        [connection.shareLimit, OPERATOR_GROUP_TIER_1_PARAMS.shareLimit],
        // Vault ownership transferred to VaultHub
        [stakingVault.owner(), vaultHub],
        // Fee state unchanged
        [dashboard.settledGrowth(), 0n],
        [dashboard.accruedFee(), 0n],
      ]);
    });

    it("funds vault", async () => {
      const settledGrowthBefore = await dashboard.settledGrowth();
      const accruedFeeBefore = await dashboard.accruedFee();

      await dashboard.connect(vaultOwner).fund({ value: fundAmount });
      vaultTotalValue += fundAmount;

      await mEqual([
        // Vault balance state
        [stakingVault.availableBalance(), vaultTotalValue],
        [currentInOutDelta(stakingVault), vaultTotalValue],
        [vaultHub.totalValue(stakingVault), vaultTotalValue],
        // Vault remains healthy
        [vaultHub.isVaultHealthy(stakingVault), true],
        // Fee state unchanged (funding increases both totalValue and inOutDelta equally)
        [dashboard.settledGrowth(), settledGrowthBefore],
        [dashboard.accruedFee(), accruedFeeBefore],
      ]);
    });

    // ==================== Part 2: Verify All PDG Operations Are Blocked ====================

    it("reverts PDG predeposit when paused", async () => {
      const validator = createValidators(1)[0];
      const depositDomain = await predepositGuarantee.DEPOSIT_DOMAIN();
      const predeposit = await generatePredeposit(validator, { depositDomain });

      await expect(
        predepositGuarantee.connect(nodeOperator).predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG topUpNodeOperatorBalance when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") }),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG setNodeOperatorGuarantor when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(stranger),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG setNodeOperatorDepositor when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(stranger),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG claimGuarantorRefund when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).claimGuarantorRefund(nodeOperator),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG proveWCAndActivate when paused", async () => {
      const mockWitness = {
        validatorIndex: 1n,
        childBlockTimestamp: 1n,
        pubkey: "0x" + "00".repeat(48),
        proof: [],
        slot: 1n,
        proposerIndex: 1n,
      };

      await expect(
        predepositGuarantee.connect(nodeOperator).proveWCAndActivate(mockWitness),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG activateValidator when paused", async () => {
      const mockPubkey = "0x" + "00".repeat(48);

      await expect(
        predepositGuarantee.connect(nodeOperator).activateValidator(mockPubkey),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG topUpExistingValidators when paused", async () => {
      const mockPubkey = "0x" + "00".repeat(48);

      await expect(
        predepositGuarantee.connect(nodeOperator).topUpExistingValidators([{ pubkey: mockPubkey, amount: ether("1") }]),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG proveWCActivateAndTopUpValidators when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).proveWCActivateAndTopUpValidators([], []),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG proveUnknownValidator when paused", async () => {
      const mockWitness = {
        validatorIndex: 1n,
        childBlockTimestamp: 1n,
        pubkey: "0x" + "00".repeat(48),
        proof: [],
        slot: 1n,
        proposerIndex: 1n,
      };

      await expect(
        predepositGuarantee.connect(nodeOperator).proveUnknownValidator(mockWitness, stakingVault),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("reverts PDG proveInvalidValidatorWC when paused", async () => {
      const mockWitness = {
        validatorIndex: 1n,
        childBlockTimestamp: 1n,
        pubkey: "0x" + "00".repeat(48),
        proof: [],
        slot: 1n,
        proposerIndex: 1n,
      };
      const mockInvalidWC = "0x" + "00".repeat(32);

      await expect(
        predepositGuarantee.connect(nodeOperator).proveInvalidValidatorWC(mockWitness, mockInvalidWC),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    // ==================== Part 3: Vault Operations Work ====================

    it("allows fund", async () => {
      const additionalFund = ether("10");
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);
      const settledGrowthBefore = await dashboard.settledGrowth();
      const accruedFeeBefore = await dashboard.accruedFee();

      await dashboard.connect(vaultOwner).fund({ value: additionalFund });
      vaultTotalValue += additionalFund;

      // Funding increases both totalValue and inOutDelta equally, so growth unchanged
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore + additionalFund],
        [currentInOutDelta(stakingVault), inOutDeltaBefore + additionalFund],
        [stakingVault.availableBalance(), vaultTotalValue],
        // Fee state should be unchanged (funding doesn't affect growth)
        [dashboard.settledGrowth(), settledGrowthBefore],
        [dashboard.accruedFee(), accruedFeeBefore],
      ]);
    });

    it("allows mint shares", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const sharesToMint = ether("10");
      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);
      const stETHBalanceBefore = await lido.balanceOf(vaultOwner);
      const stETHToReceive = await lido.getPooledEthByShares(sharesToMint);

      await dashboard.connect(vaultOwner).mintShares(vaultOwner, sharesToMint);

      await mEqual([[vaultHub.liabilityShares(stakingVault), liabilityBefore + sharesToMint]]);
      expect(await lido.balanceOf(vaultOwner)).to.equalStETH(stETHBalanceBefore + stETHToReceive);
    });

    it("allows burn shares", async () => {
      const sharesToBurn = ether("5");
      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);
      const stETHBalanceBefore = await lido.balanceOf(vaultOwner);
      const stETHToBurn = await lido.getPooledEthByShares(sharesToBurn);

      await lido.connect(vaultOwner).approve(dashboard, stETHToBurn);
      await dashboard.connect(vaultOwner).burnShares(sharesToBurn);

      await mEqual([[vaultHub.liabilityShares(stakingVault), liabilityBefore - sharesToBurn]]);
      expect(await lido.balanceOf(vaultOwner)).to.equalStETH(stETHBalanceBefore - stETHToBurn);
    });

    it("allows withdraw", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const withdrawAmount = ether("5");
      const balanceBefore = await ethers.provider.getBalance(vaultOwner);
      const withdrawable = await dashboard.withdrawableValue();
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);
      const settledGrowthBefore = await dashboard.settledGrowth();

      expect(withdrawable).to.be.gte(withdrawAmount);

      const tx = await dashboard.connect(vaultOwner).withdraw(vaultOwner, withdrawAmount);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasPrice * receipt!.gasUsed;

      vaultTotalValue -= withdrawAmount;

      const balanceAfter = await ethers.provider.getBalance(vaultOwner);
      expect(balanceAfter).to.equal(balanceBefore + withdrawAmount - gasCost);

      // Withdrawal decreases both totalValue and inOutDelta equally, so growth unchanged
      await mEqual([
        [currentInOutDelta(stakingVault), inOutDeltaBefore - withdrawAmount],
        // Fee state should be unchanged (withdrawal doesn't affect growth)
        [dashboard.settledGrowth(), settledGrowthBefore],
      ]);
    });

    // ==================== Part 4: PDG Policy Changes ====================

    it("initially has STRICT policy", async () => {
      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.STRICT]]);
    });

    it("blocks unguaranteed deposits with STRICT policy", async () => {
      const validator = createValidators(1)[0];
      const deposit = generateDepositStruct(validator.container, minActiveValidatorBalance);

      await expect(
        dashboard.connect(nodeOperatorManager).unguaranteedDepositToBeaconChain([deposit]),
      ).to.be.revertedWithCustomError(dashboard, "ForbiddenByPDGPolicy");
    });

    it("sets PDG policy to ALLOW_PROVE", async () => {
      await dashboard.connect(vaultOwner).setPDGPolicy(PDGPolicy.ALLOW_PROVE);

      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.ALLOW_PROVE]]);
    });

    it("blocks unguaranteed deposits with ALLOW_PROVE policy", async () => {
      const validator = createValidators(1)[0];
      const deposit = generateDepositStruct(validator.container, minActiveValidatorBalance);

      // Grant unguaranteed deposit role
      await dashboard
        .connect(nodeOperatorManager)
        .grantRole(await dashboard.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE(), nodeOperatorManager);

      await expect(
        dashboard.connect(nodeOperatorManager).unguaranteedDepositToBeaconChain([deposit]),
      ).to.be.revertedWithCustomError(dashboard, "ForbiddenByPDGPolicy");
    });

    it("sets PDG policy to ALLOW_DEPOSIT_AND_PROVE", async () => {
      await dashboard.connect(vaultOwner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);

      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.ALLOW_DEPOSIT_AND_PROVE]]);
    });

    // ==================== Part 5: Unguaranteed Deposits Work ====================

    it("makes unguaranteed deposit", async () => {
      // Note: NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE was already granted in ALLOW_PROVE test above
      const validator = createValidators(1)[0];
      unguaranteedValidators.push(validator);

      const deposit = generateDepositStruct(validator.container, minActiveValidatorBalance);

      // Capture complete state before deposit
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);
      const settledGrowthBefore = await dashboard.settledGrowth();
      const accruedFeeBefore = await dashboard.accruedFee();
      const feeRateBefore = await dashboard.feeRate();
      const latestCorrectionTimestampBefore = await dashboard.latestCorrectionTimestamp();

      // Unguaranteed deposit bypasses PDG - deposits directly to beacon chain
      // Fee exemption is automatically added inside unguaranteedDepositToBeaconChain
      await dashboard.connect(nodeOperatorManager).unguaranteedDepositToBeaconChain([deposit]);

      vaultTotalValue -= minActiveValidatorBalance;

      // Verify all state changes after deposit
      await mEqual([
        // Vault state
        [vaultHub.totalValue(stakingVault), totalValueBefore - minActiveValidatorBalance],
        [currentInOutDelta(stakingVault), inOutDeltaBefore - minActiveValidatorBalance],
        [lazyOracle.quarantineValue(stakingVault), 0n], // quarantine not kicked in yet
        // Fee state - exemption was automatically added
        [dashboard.settledGrowth(), settledGrowthBefore + minActiveValidatorBalance],
        [dashboard.feeRate(), feeRateBefore], // unchanged
      ]);

      // Fee exemption updates latestCorrectionTimestamp
      const latestCorrectionTimestampAfter = await dashboard.latestCorrectionTimestamp();
      expect(latestCorrectionTimestampAfter).to.be.gt(latestCorrectionTimestampBefore);

      // Accrued fee should still be 0 (no unsettled growth yet)
      expect(await dashboard.accruedFee()).to.equal(accruedFeeBefore);
    });

    it("reports unguaranteed validator to quarantine", async () => {
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);
      const settledGrowthBefore = await dashboard.settledGrowth();
      const accruedFeeBefore = await dashboard.accruedFee();

      // Report the validator as part of totalValue (simulates beacon chain showing the validator)
      const reportedValue = totalValueBefore + minActiveValidatorBalance;

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: reportedValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Total value still at previous value (quarantined)
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore],
        [currentInOutDelta(stakingVault), inOutDeltaBefore],
        [lazyOracle.quarantineValue(stakingVault), minActiveValidatorBalance],
        // Fee state should be unchanged during quarantine
        [dashboard.settledGrowth(), settledGrowthBefore],
        [dashboard.accruedFee(), accruedFeeBefore],
      ]);
    });

    it("releases unguaranteed validator from quarantine after waiting period", async () => {
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      const quarantinedValue = await lazyOracle.quarantineValue(stakingVault);
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const settledGrowthBefore = await dashboard.settledGrowth();

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + quarantinedValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      vaultTotalValue += minActiveValidatorBalance;

      // Quarantine released - total value increased
      // Fee state: growth increased but settledGrowth was already set via exemption
      const newTotalValue = totalValueBefore + quarantinedValue;

      await mEqual([
        [vaultHub.totalValue(stakingVault), newTotalValue],
        [lazyOracle.quarantineValue(stakingVault), 0n],
        [dashboard.settledGrowth(), settledGrowthBefore], // unchanged - was pre-exempted
      ]);

      // Verify no unexpected fee accrued (growth should match settled growth for exempted deposits)
      // Fee = (growth - settledGrowth) * feeRate / 10000
      // Since we exempted the deposit, unsettledGrowth should be 0
      const accruedFee = await dashboard.accruedFee();
      expect(accruedFee).to.equal(0n);
    });

    // ==================== Part 6: Side Deposits Work ====================

    it("simulates side deposit (external validator appears)", async () => {
      const sideValidator = createValidators(1)[0];
      sideDepositedValidators.push(sideValidator);

      const sideDepositAmount = minActiveValidatorBalance;
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);
      const accruedFeeBefore = await dashboard.accruedFee();
      const feeRateBefore = await dashboard.feeRate();
      const latestCorrectionTimestampBefore = await dashboard.latestCorrectionTimestamp();

      // Add fee exemption to prevent side deposit being counted as rewards
      // This is REQUIRED for side deposits (unlike unguaranteed deposits which auto-exempt)
      const settledGrowthBefore = await dashboard.settledGrowth();
      await dashboard.connect(nodeOperatorManager).addFeeExemption(sideDepositAmount);

      // Verify fee exemption state changes
      const settledGrowthAfterExemption = await dashboard.settledGrowth();
      const latestCorrectionTimestampAfterExemption = await dashboard.latestCorrectionTimestamp();

      expect(settledGrowthAfterExemption).to.equal(settledGrowthBefore + sideDepositAmount);
      expect(latestCorrectionTimestampAfterExemption).to.be.gt(latestCorrectionTimestampBefore);
      expect(await dashboard.feeRate()).to.equal(feeRateBefore); // unchanged
      expect(await dashboard.accruedFee()).to.equal(accruedFeeBefore); // unchanged until report

      // Report side deposit - will be quarantined
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + sideDepositAmount,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Value quarantined - fee state should remain unchanged
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore],
        [currentInOutDelta(stakingVault), inOutDeltaBefore],
        [lazyOracle.quarantineValue(stakingVault), sideDepositAmount],
        [dashboard.settledGrowth(), settledGrowthAfterExemption], // unchanged
        [dashboard.feeRate(), feeRateBefore], // unchanged
      ]);
    });

    it("releases side deposit from quarantine after waiting period", async () => {
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      const quarantinedValue = await lazyOracle.quarantineValue(stakingVault);
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const settledGrowthBefore = await dashboard.settledGrowth();
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + quarantinedValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      vaultTotalValue += minActiveValidatorBalance;

      const newTotalValue = totalValueBefore + quarantinedValue;
      const newGrowth = newTotalValue - inOutDeltaBefore;

      await mEqual([
        [vaultHub.totalValue(stakingVault), newTotalValue],
        [lazyOracle.quarantineValue(stakingVault), 0n],
        [dashboard.settledGrowth(), settledGrowthBefore], // unchanged - was pre-exempted
      ]);

      // Verify no unexpected fee accrued from exempted side deposit
      const accruedFee = await dashboard.accruedFee();
      const unsettledGrowth = newGrowth - settledGrowthBefore;
      if (unsettledGrowth <= 0n) {
        expect(accruedFee).to.equal(0n);
      }
    });

    // ==================== Part 7: Node Operator Fee and Settled Growth Tests ====================

    it("has zero accrued fee after fee exemptions for deposits", async () => {
      // Fee exemptions were added for:
      // 1. Unguaranteed deposit (auto-exempted in unguaranteedDepositToBeaconChain)
      // 2. Side deposit (manually exempted via addFeeExemption)
      const accruedFee = await dashboard.accruedFee();
      const settledGrowth = await dashboard.settledGrowth();
      const latestReport = await dashboard.latestReport();
      const currentGrowth = BigInt(latestReport.totalValue) - latestReport.inOutDelta;

      // Settled growth should exactly equal 2x minActiveValidatorBalance
      // (one for unguaranteed deposit, one for side deposit)
      const expectedSettledGrowth = minActiveValidatorBalance * 2n;
      expect(settledGrowth).to.equal(expectedSettledGrowth);

      // Calculate unsettled growth
      const unsettledGrowth = currentGrowth - settledGrowth;

      // Since we exempted exactly the deposit amounts, unsettled growth should be <= 0
      // (growth from deposits matches exemptions)
      expect(unsettledGrowth).to.be.lte(0n);

      // Accrued fee should be zero because all growth was exempted
      expect(accruedFee).to.equal(0n);

      // Verify fee calculation: fee = max(0, unsettledGrowth) * feeRate / 10000
      const feeRate = await dashboard.feeRate();
      expect(feeRate).to.equal(VAULT_NODE_OPERATOR_FEE); // Verify rate hasn't changed
    });

    it("accrues fee on CL rewards (growth above settled)", async () => {
      // Get current state
      const latestReportBefore = await dashboard.latestReport();
      const currentGrowthBefore = BigInt(latestReportBefore.totalValue) - latestReportBefore.inOutDelta;
      const settledGrowthBefore = await dashboard.settledGrowth();

      // Calculate how much reward we need to add to exceed settled growth
      // Add enough to ensure positive unsettled growth
      const growthDeficit = settledGrowthBefore - currentGrowthBefore;
      const clReward = growthDeficit > 0n ? growthDeficit + ether("2") : ether("2");

      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const newTotalValue = totalValueBefore + clReward;

      // Send ETH directly to vault to simulate rewards
      const vaultAddress = await stakingVault.getAddress();
      await setBalance(vaultAddress, (await ethers.provider.getBalance(vaultAddress)) + clReward);

      // Report with increased totalValue - this might get quarantined if exceeds maxRewardRatioBP
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: newTotalValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Check if value was quarantined
      const quarantineValue = await lazyOracle.quarantineValue(stakingVault);
      if (quarantineValue > 0n) {
        // Wait out quarantine period
        const quarantinePeriod = await lazyOracle.quarantinePeriod();
        await advanceChainTime(quarantinePeriod);

        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: newTotalValue,
          waitForNextRefSlot: true,
          updateReportData: true,
        });
      }

      // Verify accrued fee exists
      const accruedFeeAfter = await dashboard.accruedFee();

      // Calculate expected fee: unsettledGrowth × feeRate / 10000
      const feeRate = await dashboard.feeRate();
      const latestReportAfter = await dashboard.latestReport();
      const currentGrowthAfter = BigInt(latestReportAfter.totalValue) - latestReportAfter.inOutDelta;
      const unsettledGrowth = currentGrowthAfter - settledGrowthBefore;

      if (unsettledGrowth > 0n) {
        const expectedFee = (unsettledGrowth * BigInt(feeRate)) / 10000n;
        expect(accruedFeeAfter).to.equal(expectedFee);
        expect(accruedFeeAfter).to.be.gt(0n);
      } else {
        // If still no unsettled growth, fee should be 0
        expect(accruedFeeAfter).to.equal(0n);
      }
    });

    it("disburses node operator fee", async () => {
      const accruedFee = await dashboard.accruedFee();
      const feeRecipient = await dashboard.feeRecipient();
      const recipientBalanceBefore = await ethers.provider.getBalance(feeRecipient);
      const settledGrowthBefore = await dashboard.settledGrowth();

      if (accruedFee > 0n) {
        // If there's a fee to disburse, verify the full flow
        await expect(dashboard.connect(nodeOperator).disburseFee()).to.emit(dashboard, "FeeDisbursed");

        // Verify fee was paid
        const recipientBalanceAfter = await ethers.provider.getBalance(feeRecipient);
        expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + accruedFee);

        // Verify settled growth was updated
        const settledGrowthAfter = await dashboard.settledGrowth();
        expect(settledGrowthAfter).to.be.gte(settledGrowthBefore);

        // Verify accrued fee is now zero
        await mEqual([[dashboard.accruedFee(), 0n]]);
      } else {
        // If no fee, disburseFee should still succeed and update settled growth if needed
        const latestReport = await dashboard.latestReport();
        const currentGrowth = BigInt(latestReport.totalValue) - latestReport.inOutDelta;

        if (currentGrowth > settledGrowthBefore) {
          await expect(dashboard.connect(nodeOperator).disburseFee()).to.emit(dashboard, "SettledGrowthSet");
        } else {
          // No growth change needed, disburseFee should be a no-op
          await dashboard.connect(nodeOperator).disburseFee();
        }
        await mEqual([[dashboard.accruedFee(), 0n]]);
      }
    });

    it("changes fee recipient", async () => {
      const currentRecipient = await dashboard.feeRecipient();
      const newRecipient = stranger.address;

      await dashboard.connect(nodeOperatorManager).setFeeRecipient(newRecipient);

      await mEqual([[dashboard.feeRecipient(), newRecipient]]);

      // Change back
      await dashboard.connect(nodeOperatorManager).setFeeRecipient(currentRecipient);
      await mEqual([[dashboard.feeRecipient(), currentRecipient]]);
    });

    it("changes fee rate with dual confirmation", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const currentFeeRate = await dashboard.feeRate();
      const newFeeRate = currentFeeRate + 1_00n; // +1%

      // First confirmation from node operator manager - returns false (pending)
      expect(await dashboard.connect(nodeOperatorManager).setFeeRate.staticCall(newFeeRate)).to.equal(false);
      await dashboard.connect(nodeOperatorManager).setFeeRate(newFeeRate);
      await mEqual([[dashboard.feeRate(), currentFeeRate]]); // Not changed yet

      // Second confirmation from vault owner - returns true (applied)
      expect(await dashboard.connect(vaultOwner).setFeeRate.staticCall(newFeeRate)).to.equal(true);
      await dashboard.connect(vaultOwner).setFeeRate(newFeeRate);
      await mEqual([[dashboard.feeRate(), newFeeRate]]);
    });

    it("adds fee exemption manually", async () => {
      const settledGrowthBefore = await dashboard.settledGrowth();
      const latestCorrectionTimestampBefore = await dashboard.latestCorrectionTimestamp();
      const feeRateBefore = await dashboard.feeRate();
      const exemptionAmount = ether("0.5");

      // nodeOperatorManager can call addFeeExemption because they are admin of NODE_OPERATOR_FEE_EXEMPT_ROLE
      await expect(dashboard.connect(nodeOperatorManager).addFeeExemption(exemptionAmount))
        .to.emit(dashboard, "SettledGrowthSet")
        .to.emit(dashboard, "CorrectionTimestampUpdated");

      await mEqual([
        // Settled growth increased by exemption amount
        [dashboard.settledGrowth(), settledGrowthBefore + exemptionAmount],
        // Fee rate unchanged
        [dashboard.feeRate(), feeRateBefore],
      ]);

      // Correction timestamp updated
      const latestCorrectionTimestampAfter = await dashboard.latestCorrectionTimestamp();
      expect(latestCorrectionTimestampAfter).to.be.gt(latestCorrectionTimestampBefore);
    });

    it("corrects settled growth with dual confirmation", async () => {
      const currentSettledGrowth = await dashboard.settledGrowth();
      const latestCorrectionTimestampBefore = await dashboard.latestCorrectionTimestamp();
      const newSettledGrowth = currentSettledGrowth + ether("0.1");

      // First confirmation from node operator manager - returns false (pending)
      expect(
        await dashboard
          .connect(nodeOperatorManager)
          .correctSettledGrowth.staticCall(newSettledGrowth, currentSettledGrowth),
      ).to.equal(false);
      await dashboard.connect(nodeOperatorManager).correctSettledGrowth(newSettledGrowth, currentSettledGrowth);

      // Verify nothing changed after first confirmation
      await mEqual([
        [dashboard.settledGrowth(), currentSettledGrowth],
        [dashboard.latestCorrectionTimestamp(), latestCorrectionTimestampBefore],
      ]);

      // Second confirmation from vault owner - returns true (applied)
      expect(
        await dashboard.connect(vaultOwner).correctSettledGrowth.staticCall(newSettledGrowth, currentSettledGrowth),
      ).to.equal(true);
      await expect(dashboard.connect(vaultOwner).correctSettledGrowth(newSettledGrowth, currentSettledGrowth))
        .to.emit(dashboard, "SettledGrowthSet")
        .to.emit(dashboard, "CorrectionTimestampUpdated");

      // Verify changes applied
      await mEqual([[dashboard.settledGrowth(), newSettledGrowth]]);

      // Verify correction timestamp updated
      const latestCorrectionTimestampAfter = await dashboard.latestCorrectionTimestamp();
      expect(latestCorrectionTimestampAfter).to.be.gt(latestCorrectionTimestampBefore);
    });

    // ==================== Part 8: Tier Changes Work (with PDG paused) ====================

    it("changes tier", async () => {
      // Burn all shares first (tier 2 has higher reserve ratio)
      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      if (liabilityShares > 0n) {
        await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(liabilityShares));
        await dashboard.connect(vaultOwner).burnShares(liabilityShares);
      }
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);

      const settledGrowthBefore = await dashboard.settledGrowth();
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const tierAltShareLimit = ether("800");

      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, OPERATOR_GROUP_TIER_2_ID, tierAltShareLimit);
      await expect(dashboard.connect(vaultOwner).changeTier(OPERATOR_GROUP_TIER_2_ID, tierAltShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const [, tierAfterId, tierAfterShareLimit] = await operatorGrid.vaultTierInfo(stakingVault);
      const connectionAfter = await vaultHub.vaultConnection(stakingVault);

      await mEqual([
        // Tier changed
        [tierAfterId, OPERATOR_GROUP_TIER_2_ID],
        // vaultTierInfo returns the tier's max share limit
        [tierAfterShareLimit, OPERATOR_GROUP_TIER_2_PARAMS.shareLimit],
        // Connection updated with requested share limit (not tier max)
        [connectionAfter.shareLimit, tierAltShareLimit],
        // Vault state unchanged
        [vaultHub.isVaultConnected(stakingVault), true],
        [vaultHub.isVaultHealthy(stakingVault), true],
        [vaultHub.totalValue(stakingVault), totalValueBefore],
        // Fee state unchanged
        [dashboard.settledGrowth(), settledGrowthBefore],
      ]);
    });

    it("changes tier back", async () => {
      const settledGrowthBefore = await dashboard.settledGrowth();
      const tierPrimaryShareLimit = ether("900");

      await operatorGrid
        .connect(nodeOperator)
        .changeTier(stakingVault, OPERATOR_GROUP_TIER_1_ID, tierPrimaryShareLimit);
      await expect(dashboard.connect(vaultOwner).changeTier(OPERATOR_GROUP_TIER_1_ID, tierPrimaryShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const [, tierFinalId, tierFinalShareLimit] = await operatorGrid.vaultTierInfo(stakingVault);
      const connectionAfter = await vaultHub.vaultConnection(stakingVault);

      await mEqual([
        // Tier changed back
        [tierFinalId, OPERATOR_GROUP_TIER_1_ID],
        // vaultTierInfo returns the tier's max share limit
        [tierFinalShareLimit, OPERATOR_GROUP_TIER_1_PARAMS.shareLimit],
        // Connection updated with requested share limit (not tier max)
        [connectionAfter.shareLimit, tierPrimaryShareLimit],
        // Vault remains healthy
        [vaultHub.isVaultHealthy(stakingVault), true],
        // Fee state unchanged
        [dashboard.settledGrowth(), settledGrowthBefore],
      ]);
    });

    it("updates share limit", async () => {
      const shareLimitBefore = (await vaultHub.vaultConnection(stakingVault)).shareLimit;
      const settledGrowthBefore = await dashboard.settledGrowth();
      const newShareLimit = ether("600");

      await operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, newShareLimit);
      await expect(dashboard.connect(vaultOwner).updateShareLimit(newShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const connection = await vaultHub.vaultConnection(stakingVault);
      const [, tierId] = await operatorGrid.vaultTierInfo(stakingVault);

      await mEqual([
        // Share limit updated
        [connection.shareLimit, newShareLimit],
        // Tier unchanged
        [tierId, OPERATOR_GROUP_TIER_1_ID],
        // Vault remains healthy and connected
        [vaultHub.isVaultConnected(stakingVault), true],
        [vaultHub.isVaultHealthy(stakingVault), true],
        // Fee state unchanged
        [dashboard.settledGrowth(), settledGrowthBefore],
      ]);

      // Verify share limit actually changed
      expect(newShareLimit).to.not.equal(shareLimitBefore);
    });

    // ==================== Part 9: Prove Validators is Blocked ====================

    it("blocks proving validators via dashboard", async () => {
      // Add validators to mock CL tree
      await addValidatorsToTree(unguaranteedValidators);
      const { header, timestamp } = await commitAndProveValidators(unguaranteedValidators, 100);
      const witnesses = toWitnesses(unguaranteedValidators, header, timestamp);

      // Grant prove role
      await dashboard
        .connect(nodeOperatorManager)
        .grantRole(await dashboard.NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE(), nodeOperatorManager);

      // Proving should fail because PDG is paused
      await expect(
        dashboard.connect(nodeOperatorManager).proveUnknownValidatorsToPDG(witnesses),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    // ==================== Part 10: Rebalance, Disconnect, Reconnect, and Ossify ====================

    it("rebalances vault", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const sharesToMint = ether("5");
      const stETHBalanceBefore = await lido.balanceOf(vaultOwner);
      const stETHToReceive = await lido.getPooledEthByShares(sharesToMint);

      await dashboard.connect(vaultOwner).mintShares(vaultOwner, sharesToMint);

      // Verify minting worked
      expect(await lido.balanceOf(vaultOwner)).to.equalStETH(stETHBalanceBefore + stETHToReceive);

      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      expect(liabilityShares).to.be.gt(0n);

      const stETHNeeded = await lido.getPooledEthByShares(liabilityShares);

      // Approve and rebalance
      await lido.connect(vaultOwner).approve(dashboard, stETHNeeded);
      await dashboard.connect(vaultOwner).rebalanceVaultWithShares(liabilityShares);

      await mEqual([
        // Liability cleared
        [vaultHub.liabilityShares(stakingVault), 0n],
        // Vault remains healthy
        [vaultHub.isVaultHealthy(stakingVault), true],
        [vaultHub.isVaultConnected(stakingVault), true],
      ]);
    });

    it("disconnects vault", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const accruedFeeBefore = await dashboard.accruedFee();

      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.equal(true);

      // Fee leftover should be set (collected before disconnect)
      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.equal(accruedFeeBefore);

      await expect(reportVaultDataWithProof(ctx, stakingVault))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      await mEqual([
        // Vault disconnected
        [vaultHub.isVaultConnected(stakingVault), false],
        [vaultHub.isPendingDisconnect(stakingVault), false],
        // Ownership pending transfer to dashboard (2-step transfer)
        // owner() is still VaultHub until dashboard calls acceptOwnership()
        [stakingVault.pendingOwner(), dashboard],
        // Liability should be zero
        [vaultHub.liabilityShares(stakingVault), 0n],
      ]);
    });

    it("reconnects vault to VaultHub", async () => {
      // Recover any fee leftover first
      const feeLeftover = await dashboard.feeLeftover();
      const feeRecipient = await dashboard.feeRecipient();
      const feeRecipientBalanceBefore = await ethers.provider.getBalance(feeRecipient);

      if (feeLeftover > 0n) {
        await dashboard.connect(nodeOperatorManager).recoverFeeLeftover();
        expect(await dashboard.feeLeftover()).to.equal(0n);
        // Verify fee was paid to recipient
        expect(await ethers.provider.getBalance(feeRecipient)).to.equal(feeRecipientBalanceBefore + feeLeftover);
      }

      // Correct settled growth to zero for reconnection
      // This is required because settledGrowth is set to MAX during disconnect
      const currentSettledGrowth = await dashboard.settledGrowth();
      if (currentSettledGrowth > 0n) {
        await dashboard.connect(nodeOperatorManager).correctSettledGrowth(0n, currentSettledGrowth);
        await dashboard.connect(vaultOwner).correctSettledGrowth(0n, currentSettledGrowth);
      }
      expect(await dashboard.settledGrowth()).to.equal(0n);

      // Reconnect
      await dashboard.connect(vaultOwner).reconnectToVaultHub();

      await mEqual([
        // Vault reconnected
        [vaultHub.isVaultConnected(stakingVault), true],
        [vaultHub.isVaultHealthy(stakingVault), true],
        // Ownership transferred to VaultHub
        [stakingVault.owner(), vaultHub],
        // Fee state reset
        [dashboard.settledGrowth(), 0n],
        [dashboard.feeLeftover(), 0n],
        [dashboard.accruedFee(), 0n],
      ]);
    });

    it("disconnects vault again for ossification test", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      // Burn all liability shares if any
      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      if (liabilityShares > 0n) {
        const stETHToApprove = await lido.getPooledEthByShares(liabilityShares);
        await lido.connect(vaultOwner).approve(dashboard, stETHToApprove);
        await dashboard.connect(vaultOwner).burnShares(liabilityShares);
      }
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);

      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.equal(true);

      await reportVaultDataWithProof(ctx, stakingVault);

      await mEqual([
        // Vault disconnected
        [vaultHub.isVaultConnected(stakingVault), false],
        [vaultHub.isPendingDisconnect(stakingVault), false],
        // Ownership pending transfer to dashboard (2-step transfer)
        [stakingVault.pendingOwner(), dashboard],
        // No liability
        [vaultHub.liabilityShares(stakingVault), 0n],
      ]);
    });

    it("ossifies vault after abandoning dashboard", async () => {
      // Verify preconditions (ownership is pending, not yet accepted)
      expect(await stakingVault.pendingOwner()).to.equal(await dashboard.getAddress());
      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);

      // Abandon dashboard to transfer vault ownership to stranger
      await dashboard.connect(vaultOwner).abandonDashboard(stranger.address);

      await mEqual([
        // Pending ownership transfer
        [stakingVault.pendingOwner(), stranger.address],
        // Current owner still dashboard until acceptance
        [stakingVault.owner(), dashboard],
      ]);

      // Stranger accepts ownership
      await stakingVault.connect(stranger).acceptOwnership();

      await mEqual([
        // Ownership transferred
        [stakingVault.owner(), stranger.address],
        [stakingVault.pendingOwner(), ethers.ZeroAddress],
        // Vault still disconnected
        [vaultHub.isVaultConnected(stakingVault), false],
      ]);

      // Verify vault is not ossified yet
      const proxy = await ethers.getContractAt("PinnedBeaconProxy", stakingVault);
      expect(await proxy.isOssified()).to.equal(false);

      // Ossify the vault
      await stakingVault.connect(stranger).ossify();

      // Verify ossification
      expect(await proxy.isOssified()).to.equal(true);

      // Verify vault basic functionality still works (read-only)
      expect(await stakingVault.nodeOperator()).to.equal(nodeOperator.address);
      expect(await stakingVault.depositor()).to.equal(await predepositGuarantee.getAddress());
    });

    // ==================== Helper Functions ====================

    function createValidators(count: number): ValidatorInfo[] {
      return Array.from({ length: count }, () => ({
        ...generateValidator(withdrawalCredentials),
        index: 0,
        proof: [],
      }));
    }

    async function addValidatorsToTree(validators: ValidatorInfo[]) {
      if (!mockCLtree) throw new Error("mockCLtree not initialized");
      for (const validator of validators) {
        validator.index = (await mockCLtree.addValidator(validator.container)).validatorIndex;
      }
    }

    async function commitAndProveValidators(validators: ValidatorInfo[], slotOffset: number) {
      if (!mockCLtree) throw new Error("mockCLtree not initialized");

      ({ childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(
        Number(slot) + slotOffset,
      ));

      for (const validator of validators) {
        validator.proof = await mockCLtree.buildProof(validator.index, beaconBlockHeader);
      }

      return { header: beaconBlockHeader, timestamp: childBlockTimestamp };
    }

    function toWitnesses(
      validators: ValidatorInfo[],
      header: SSZBLSHelpers.BeaconBlockHeaderStruct,
      timestamp: number,
    ) {
      return validators.map((validator) => ({
        proof: validator.proof,
        pubkey: hexlify(validator.container.pubkey),
        validatorIndex: validator.index,
        childBlockTimestamp: timestamp,
        slot: header.slot,
        proposerIndex: header.proposerIndex,
      }));
    }

    async function currentInOutDelta(vault: StakingVault): Promise<bigint> {
      const record = await vaultHub.vaultRecord(await vault.getAddress());
      const [cache0, cache1] = record.inOutDelta;
      return cache0.refSlot >= cache1.refSlot ? cache0.value : cache1.value;
    }
  }),
);
