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

      const pdgIsPaused = await predepositGuarantee.isPaused();
      if (!pdgIsPaused) {
        // Pause PDG before any tests
        const PAUSE_ROLE = await predepositGuarantee.PAUSE_ROLE();
        await expect(predepositGuarantee.connect(agent).grantRole(PAUSE_ROLE, agent))
          .to.emit(predepositGuarantee, "RoleGranted")
          .withArgs(PAUSE_ROLE, agent, agent);

        const PAUSE_INFINITELY = await predepositGuarantee.PAUSE_INFINITELY();
        await expect(predepositGuarantee.connect(agent).pauseFor(PAUSE_INFINITELY))
          .to.emit(predepositGuarantee, "Paused")
          .withArgs(PAUSE_INFINITELY);

        expect(await predepositGuarantee.isPaused()).to.equal(true);
      }

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
      await expect(operatorGrid.connect(agent).registerGroup(nodeOperator, OPERATOR_GROUP_SHARE_LIMIT))
        .to.emit(operatorGrid, "GroupAdded")
        .withArgs(nodeOperator, OPERATOR_GROUP_SHARE_LIMIT);

      const registeredGroup = await operatorGrid.group(nodeOperator);
      await mEqual([
        [registeredGroup.operator, nodeOperator],
        [registeredGroup.shareLimit, OPERATOR_GROUP_SHARE_LIMIT],
        [registeredGroup.tierIds.length, 0],
      ]);
    });

    it("registers tiers", async () => {
      const tiersCount = await operatorGrid.tiersCount();
      OPERATOR_GROUP_TIER_1_ID = tiersCount;
      OPERATOR_GROUP_TIER_2_ID = tiersCount + 1n;

      await expect(
        operatorGrid
          .connect(agent)
          .registerTiers(nodeOperator, [OPERATOR_GROUP_TIER_1_PARAMS, OPERATOR_GROUP_TIER_2_PARAMS]),
      )
        .to.emit(operatorGrid, "TierAdded")
        .withArgs(
          nodeOperator,
          OPERATOR_GROUP_TIER_1_ID,
          OPERATOR_GROUP_TIER_1_PARAMS.shareLimit,
          OPERATOR_GROUP_TIER_1_PARAMS.reserveRatioBP,
          OPERATOR_GROUP_TIER_1_PARAMS.forcedRebalanceThresholdBP,
          OPERATOR_GROUP_TIER_1_PARAMS.infraFeeBP,
          OPERATOR_GROUP_TIER_1_PARAMS.liquidityFeeBP,
          OPERATOR_GROUP_TIER_1_PARAMS.reservationFeeBP,
        )
        .and.to.emit(operatorGrid, "TierAdded")
        .withArgs(
          nodeOperator,
          OPERATOR_GROUP_TIER_2_ID,
          OPERATOR_GROUP_TIER_2_PARAMS.shareLimit,
          OPERATOR_GROUP_TIER_2_PARAMS.reserveRatioBP,
          OPERATOR_GROUP_TIER_2_PARAMS.forcedRebalanceThresholdBP,
          OPERATOR_GROUP_TIER_2_PARAMS.infraFeeBP,
          OPERATOR_GROUP_TIER_2_PARAMS.liquidityFeeBP,
          OPERATOR_GROUP_TIER_2_PARAMS.reservationFeeBP,
        );

      const group = await operatorGrid.group(nodeOperator);
      await mEqual([
        [group.tierIds.length, 2],
        [group.shareLimit, OPERATOR_GROUP_SHARE_LIMIT],
      ]);
    });

    it("connects to VaultHub with tier", async () => {
      // Node operator pre-approves tier change (no event - just stores approval)
      await expect(
        operatorGrid
          .connect(nodeOperator)
          .changeTier(stakingVault, OPERATOR_GROUP_TIER_1_ID, OPERATOR_GROUP_TIER_1_PARAMS.shareLimit),
      ).to.not.emit(operatorGrid, "TierChanged");

      const defaultTierParams = await operatorGrid.tier(0);

      await expect(
        dashboard
          .connect(vaultOwner)
          .connectAndAcceptTier(OPERATOR_GROUP_TIER_1_ID, OPERATOR_GROUP_TIER_1_PARAMS.shareLimit, {
            value: VAULT_CONNECTION_DEPOSIT,
          }),
      )
        .to.emit(vaultHub, "VaultConnected")
        .and.to.emit(stakingVault, "EtherFunded")
        .withArgs(VAULT_CONNECTION_DEPOSIT)
        .and.to.emit(stakingVault, "OwnershipTransferred")
        .withArgs(dashboard, vaultHub)
        .and.to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          stakingVault,
          nodeOperator,
          OPERATOR_GROUP_TIER_1_PARAMS.shareLimit,
          OPERATOR_GROUP_TIER_1_PARAMS.reserveRatioBP,
          OPERATOR_GROUP_TIER_1_PARAMS.forcedRebalanceThresholdBP,
        )
        .and.to.emit(vaultHub, "VaultFeesUpdated")
        .withArgs(
          stakingVault,
          defaultTierParams.infraFeeBP,
          defaultTierParams.liquidityFeeBP,
          defaultTierParams.reservationFeeBP,
          OPERATOR_GROUP_TIER_1_PARAMS.infraFeeBP,
          OPERATOR_GROUP_TIER_1_PARAMS.liquidityFeeBP,
          OPERATOR_GROUP_TIER_1_PARAMS.reservationFeeBP,
        )
        .and.to.emit(operatorGrid, "TierChanged")
        .withArgs(stakingVault, OPERATOR_GROUP_TIER_1_ID, OPERATOR_GROUP_TIER_1_PARAMS.shareLimit);

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
        [connection.reserveRatioBP, OPERATOR_GROUP_TIER_1_PARAMS.reserveRatioBP],
        [connection.forcedRebalanceThresholdBP, OPERATOR_GROUP_TIER_1_PARAMS.forcedRebalanceThresholdBP],
        [connection.infraFeeBP, OPERATOR_GROUP_TIER_1_PARAMS.infraFeeBP],
        [connection.liquidityFeeBP, OPERATOR_GROUP_TIER_1_PARAMS.liquidityFeeBP],
        [connection.reservationFeeBP, OPERATOR_GROUP_TIER_1_PARAMS.reservationFeeBP],
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

      const expectedInOutDeltaAfterFund = vaultTotalValue + fundAmount;
      await expect(dashboard.connect(vaultOwner).fund({ value: fundAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundAmount)
        .and.to.emit(vaultHub, "VaultInOutDeltaUpdated")
        .withArgs(stakingVault, expectedInOutDeltaAfterFund);

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

    it("reverts PDG withdrawNodeOperatorBalance when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).withdrawNodeOperatorBalance(nodeOperator, ether("1"), nodeOperator),
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

    it("allows direct ETH transfer via receive()", async () => {
      const directTransferAmount = ether("1");
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);
      const settledGrowthBefore = await dashboard.settledGrowth();
      const accruedFeeBefore = await dashboard.accruedFee();
      const balanceBefore = await stakingVault.availableBalance();

      // Send ETH directly to the vault via receive() - simulates execution layer rewards
      await stranger.sendTransaction({
        to: stakingVault,
        value: directTransferAmount,
      });

      // Balance increases but no events emitted (receive() is a bare function)
      const newBalance = await stakingVault.availableBalance();
      expect(newBalance).to.equal(balanceBefore + directTransferAmount);

      // KEY ASSERTION: inOutDelta should NOT change - this is the difference from VaultHub.fund()
      // When ETH is sent directly to the vault (e.g., execution layer rewards), it creates "growth"
      // because the balance increases but inOutDelta stays the same
      expect(await currentInOutDelta(stakingVault)).to.equal(inOutDeltaBefore);

      // Fees don't change until a report is submitted (VaultHub reads from cached report data)
      await mEqual([
        [dashboard.settledGrowth(), settledGrowthBefore],
        [dashboard.accruedFee(), accruedFeeBefore],
      ]);

      // Submit a fresh report with the new total value (including direct transfer)
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const newTotalValue = totalValueBefore + directTransferAmount;
      await reportVaultDataWithProof(ctx, stakingVault, {
        waitForNextRefSlot: true,
        totalValue: newTotalValue,
      });

      // After report: totalValue increases but inOutDelta stays the same, creating growth
      expect(await vaultHub.totalValue(stakingVault)).to.equal(newTotalValue);
      expect(await currentInOutDelta(stakingVault)).to.equal(inOutDeltaBefore);

      // Growth = totalValue - inOutDelta, unsettledGrowth = growth - settledGrowth
      const currentGrowth = newTotalValue - inOutDeltaBefore;
      const unsettledGrowth = currentGrowth - settledGrowthBefore;

      // With a non-zero fee rate, accrued fee should increase based on unsettled growth
      const feeRate = await dashboard.feeRate();
      const expectedFee = (unsettledGrowth * feeRate) / 10000n;

      expect(await dashboard.accruedFee()).to.equal(expectedFee);
      expect(expectedFee).to.be.gt(accruedFeeBefore);

      // Disburse fees to reset fee state for subsequent tests
      const feeRecipient = await dashboard.feeRecipient();
      const feeRecipientBalanceBefore = await ethers.provider.getBalance(feeRecipient);

      const disburseTx = await dashboard.disburseFee();
      await expect(disburseTx).to.emit(dashboard, "FeeDisbursed");

      // Verify fee was disbursed correctly
      const feeRecipientBalanceAfter = await ethers.provider.getBalance(feeRecipient);
      expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalanceBefore + expectedFee);
      expect(await dashboard.accruedFee()).to.equal(0n);

      // Update tracking variable for subsequent tests
      // Direct transfer added funds, fee disbursement withdrew funds
      vaultTotalValue += directTransferAmount - expectedFee;
    });

    it("allows mint shares", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const sharesToMint = ether("10");
      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);
      const stETHBalanceBefore = await lido.balanceOf(vaultOwner);
      const stETHToReceive = await lido.getPooledEthByShares(sharesToMint);

      await expect(dashboard.connect(vaultOwner).mintShares(vaultOwner, sharesToMint))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .and.to.emit(lido, "Transfer")
        .withArgs(ethers.ZeroAddress, vaultOwner, stETHToReceive)
        .and.to.emit(lido, "ExternalSharesMinted")
        .withArgs(vaultOwner, sharesToMint);

      await mEqual([[vaultHub.liabilityShares(stakingVault), liabilityBefore + sharesToMint]]);
      expect(await lido.balanceOf(vaultOwner)).to.equalStETH(stETHBalanceBefore + stETHToReceive);
    });

    it("allows burn shares", async () => {
      const sharesToBurn = ether("5");
      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);
      const stETHBalanceBefore = await lido.balanceOf(vaultOwner);
      const stETHToBurn = await lido.getPooledEthByShares(sharesToBurn);

      await expect(lido.connect(vaultOwner).approve(dashboard, stETHToBurn))
        .to.emit(lido, "Approval")
        .withArgs(vaultOwner, dashboard, stETHToBurn);

      await expect(dashboard.connect(vaultOwner).burnShares(sharesToBurn))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, sharesToBurn)
        .and.to.emit(lido, "ExternalSharesBurnt")
        .withArgs(sharesToBurn);

      await mEqual([[vaultHub.liabilityShares(stakingVault), liabilityBefore - sharesToBurn]]);
      expect(await lido.balanceOf(vaultOwner)).to.equalStETH(stETHBalanceBefore - stETHToBurn);
    });

    it("allows withdraw", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const withdrawAmount = ether("5");
      const balanceBefore = await ethers.provider.getBalance(stranger);
      const withdrawable = await dashboard.withdrawableValue();
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);
      const settledGrowthBefore = await dashboard.settledGrowth();

      expect(withdrawable).to.be.gte(withdrawAmount);

      await expect(dashboard.connect(vaultOwner).withdraw(stranger, withdrawAmount))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, withdrawAmount)
        .and.to.emit(vaultHub, "VaultInOutDeltaUpdated")
        .withArgs(stakingVault, inOutDeltaBefore - withdrawAmount);

      vaultTotalValue -= withdrawAmount;

      // Withdrawal decreases both totalValue and inOutDelta equally, so growth unchanged
      await mEqual([
        [vaultHub.totalValue(stakingVault), vaultTotalValue],
        [currentInOutDelta(stakingVault), inOutDeltaBefore - withdrawAmount],
        // Fee state should be unchanged (withdrawal doesn't affect growth)
        [dashboard.settledGrowth(), settledGrowthBefore],
        [ethers.provider.getBalance(stranger), balanceBefore + withdrawAmount],
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
      await expect(dashboard.connect(vaultOwner).setPDGPolicy(PDGPolicy.ALLOW_PROVE))
        .to.emit(dashboard, "PDGPolicyEnacted")
        .withArgs(PDGPolicy.ALLOW_PROVE);

      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.ALLOW_PROVE]]);
    });

    it("blocks unguaranteed deposits with ALLOW_PROVE policy", async () => {
      const validator = createValidators(1)[0];
      const deposit = generateDepositStruct(validator.container, minActiveValidatorBalance);

      await expect(
        dashboard.connect(nodeOperatorManager).unguaranteedDepositToBeaconChain([deposit]),
      ).to.be.revertedWithCustomError(dashboard, "ForbiddenByPDGPolicy");
    });

    it("sets PDG policy to ALLOW_DEPOSIT_AND_PROVE", async () => {
      await expect(dashboard.connect(vaultOwner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE))
        .to.emit(dashboard, "PDGPolicyEnacted")
        .withArgs(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);

      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.ALLOW_DEPOSIT_AND_PROVE]]);
    });

    // ==================== Part 5: Unguaranteed Deposits Work ====================

    it("makes unguaranteed deposit, quarantines, and releases after waiting period", async () => {
      // Note: NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE was already granted in ALLOW_PROVE test above
      const validator = createValidators(1)[0];
      unguaranteedValidators.push(validator);

      const deposit = generateDepositStruct(validator.container, minActiveValidatorBalance);

      // ========== Step 1: Make unguaranteed deposit ==========
      // Capture complete state before deposit
      const totalValueBeforeDeposit = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBeforeDeposit = await currentInOutDelta(stakingVault);
      const settledGrowthBeforeDeposit = await dashboard.settledGrowth();
      const accruedFeeBeforeDeposit = await dashboard.accruedFee();
      const feeRateBeforeDeposit = await dashboard.feeRate();
      const latestCorrectionTimestampBeforeDeposit = await dashboard.latestCorrectionTimestamp();

      // Unguaranteed deposit bypasses PDG - deposits directly to beacon chain
      // Fee exemption is automatically added inside unguaranteedDepositToBeaconChain
      await expect(dashboard.connect(nodeOperatorManager).unguaranteedDepositToBeaconChain([deposit]))
        .to.emit(dashboard, "UnguaranteedDeposits")
        .withArgs(stakingVault, 1, minActiveValidatorBalance)
        .and.to.emit(dashboard, "SettledGrowthSet")
        .withArgs(settledGrowthBeforeDeposit, settledGrowthBeforeDeposit + minActiveValidatorBalance)
        .and.to.emit(dashboard, "CorrectionTimestampUpdated")
        .and.to.emit(vaultHub, "VaultInOutDeltaUpdated")
        .withArgs(stakingVault, inOutDeltaBeforeDeposit - minActiveValidatorBalance)
        .and.to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(dashboard, minActiveValidatorBalance);

      vaultTotalValue -= minActiveValidatorBalance;

      // Verify state after deposit
      await mEqual([
        // Vault state - balance decreased (ETH sent to beacon chain)
        [vaultHub.totalValue(stakingVault), totalValueBeforeDeposit - minActiveValidatorBalance],
        [currentInOutDelta(stakingVault), inOutDeltaBeforeDeposit - minActiveValidatorBalance],
        [lazyOracle.quarantineValue(stakingVault), 0n], // quarantine not kicked in yet
        // Fee state - exemption was automatically added for the deposit
        [dashboard.settledGrowth(), settledGrowthBeforeDeposit + minActiveValidatorBalance],
        [dashboard.feeRate(), feeRateBeforeDeposit], // unchanged
        [dashboard.accruedFee(), accruedFeeBeforeDeposit], // unchanged
      ]);

      // Fee exemption updates latestCorrectionTimestamp
      expect(await dashboard.latestCorrectionTimestamp()).to.be.gt(latestCorrectionTimestampBeforeDeposit);

      // ========== Step 2: Report validator to quarantine ==========
      // Simulates beacon chain showing the validator has been activated
      const totalValueBeforeReport = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBeforeReport = await currentInOutDelta(stakingVault);
      const settledGrowthBeforeReport = await dashboard.settledGrowth();
      const accruedFeeBeforeReport = await dashboard.accruedFee();

      // Report the validator as part of totalValue
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBeforeReport + minActiveValidatorBalance,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Value increase is quarantined - totalValue stays the same until release
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBeforeReport],
        [currentInOutDelta(stakingVault), inOutDeltaBeforeReport],
        [lazyOracle.quarantineValue(stakingVault), minActiveValidatorBalance],
        // Fee state unchanged during quarantine
        [dashboard.settledGrowth(), settledGrowthBeforeReport],
        [dashboard.accruedFee(), accruedFeeBeforeReport],
      ]);

      // ========== Step 3: Release from quarantine after waiting period ==========
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      const quarantinedValue = await lazyOracle.quarantineValue(stakingVault);
      const totalValueBeforeRelease = await vaultHub.totalValue(stakingVault);
      const settledGrowthBeforeRelease = await dashboard.settledGrowth();

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBeforeRelease + quarantinedValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      vaultTotalValue += minActiveValidatorBalance;

      // Quarantine released - total value now includes the validator
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBeforeRelease + quarantinedValue],
        [lazyOracle.quarantineValue(stakingVault), 0n],
        // settledGrowth unchanged - was pre-exempted during deposit
        [dashboard.settledGrowth(), settledGrowthBeforeRelease],
      ]);

      // Verify no unexpected fee accrued
      // Since we pre-exempted the deposit amount, unsettledGrowth should be 0
      expect(await dashboard.accruedFee()).to.equal(0n);
    });

    // ==================== Part 6: Side Deposits Work ====================

    it("handles side deposit: exempts fee, quarantines, and releases after waiting period", async () => {
      const sideValidator = createValidators(1)[0];
      sideDepositedValidators.push(sideValidator);

      const sideDepositAmount = minActiveValidatorBalance;

      // ========== Step 1: Add fee exemption for side deposit ==========
      // Unlike unguaranteed deposits, side deposits require MANUAL fee exemption
      const totalValueBeforeExemption = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBeforeExemption = await currentInOutDelta(stakingVault);
      const settledGrowthBeforeExemption = await dashboard.settledGrowth();
      const accruedFeeBeforeExemption = await dashboard.accruedFee();
      const feeRateBeforeExemption = await dashboard.feeRate();
      const latestCorrectionTimestampBeforeExemption = await dashboard.latestCorrectionTimestamp();

      await expect(dashboard.connect(nodeOperatorManager).addFeeExemption(sideDepositAmount))
        .to.emit(dashboard, "SettledGrowthSet")
        .withArgs(settledGrowthBeforeExemption, settledGrowthBeforeExemption + sideDepositAmount)
        .and.to.emit(dashboard, "CorrectionTimestampUpdated");

      // Verify fee exemption state changes
      const settledGrowthAfterExemption = await dashboard.settledGrowth();

      await mEqual([
        [dashboard.settledGrowth(), settledGrowthBeforeExemption + sideDepositAmount],
        [dashboard.feeRate(), feeRateBeforeExemption], // unchanged
        [dashboard.accruedFee(), accruedFeeBeforeExemption], // unchanged until report
      ]);
      expect(await dashboard.latestCorrectionTimestamp()).to.be.gt(latestCorrectionTimestampBeforeExemption);

      // ========== Step 2: Report side deposit to quarantine ==========
      // Simulates an external validator appearing on the beacon chain
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBeforeExemption + sideDepositAmount,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Value is quarantined - totalValue unchanged, fee state unchanged
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBeforeExemption],
        [currentInOutDelta(stakingVault), inOutDeltaBeforeExemption],
        [lazyOracle.quarantineValue(stakingVault), sideDepositAmount],
        [dashboard.settledGrowth(), settledGrowthAfterExemption], // unchanged
        [dashboard.feeRate(), feeRateBeforeExemption], // unchanged
      ]);

      // ========== Step 3: Release from quarantine after waiting period ==========
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      const quarantinedValue = await lazyOracle.quarantineValue(stakingVault);
      const totalValueBeforeRelease = await vaultHub.totalValue(stakingVault);
      const settledGrowthBeforeRelease = await dashboard.settledGrowth();
      const inOutDeltaBeforeRelease = await currentInOutDelta(stakingVault);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBeforeRelease + quarantinedValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      vaultTotalValue += minActiveValidatorBalance;

      // Quarantine released - total value now includes the side deposit
      await mEqual([
        [vaultHub.totalValue(stakingVault), vaultTotalValue],
        [currentInOutDelta(stakingVault), inOutDeltaBeforeRelease],
        [lazyOracle.quarantineValue(stakingVault), 0n],
        // settledGrowth unchanged - was pre-exempted
        [dashboard.settledGrowth(), settledGrowthBeforeRelease],
        [dashboard.accruedFee(), 0n],
      ]);
    });

    // ==================== Part 7: Node Operator Fee and Settled Growth Tests ====================

    it("accrues fee on CL rewards and disburses to fee recipient", async () => {
      // Verify starting state: unsettled growth is 0 (all previous growth was exempted)
      const settledGrowthBefore = await dashboard.settledGrowth();
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);
      const feeRecipient = await dashboard.feeRecipient();
      const recipientBalanceBefore = await ethers.provider.getBalance(feeRecipient);

      await mEqual([[dashboard.accruedFee(), 0n]]);

      // Step 1: Report CL rewards (1 ETH increase in totalValue)
      // This is below maxRewardRatioBP so it won't be quarantined
      const clReward = ether("1");
      const newTotalValue = totalValueBefore + clReward;

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: newTotalValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // CL rewards are not quarantined (small amount relative to total value)
      expect(await lazyOracle.quarantineValue(stakingVault)).to.equal(0n);

      // Growth increased by clReward, settledGrowth unchanged
      // unsettledGrowth = clReward, so fee accrues
      const expectedFee = (clReward * VAULT_NODE_OPERATOR_FEE) / 10000n; // 5% of 1 ETH = 0.05 ETH

      await mEqual([
        [vaultHub.totalValue(stakingVault), newTotalValue],
        [dashboard.settledGrowth(), settledGrowthBefore],
        [dashboard.accruedFee(), expectedFee],
      ]);

      // Step 2: Disburse the fee
      await expect(dashboard.connect(nodeOperator).disburseFee())
        .to.emit(dashboard, "FeeDisbursed")
        .withArgs(nodeOperator, expectedFee, feeRecipient);

      // Verify fee was paid and state updated
      const newSettledGrowth = settledGrowthBefore + clReward;

      await mEqual([
        [ethers.provider.getBalance(feeRecipient), recipientBalanceBefore + expectedFee],
        [dashboard.settledGrowth(), newSettledGrowth],
        [dashboard.accruedFee(), 0n],
        [currentInOutDelta(stakingVault), inOutDeltaBefore - expectedFee],
      ]);

      // Update tracking variable (CL rewards added, fee withdrawn)
      vaultTotalValue += clReward - expectedFee;
    });

    it("changes fee recipient", async () => {
      const currentRecipient = await dashboard.feeRecipient();
      const newRecipient = stranger;

      await expect(dashboard.connect(nodeOperatorManager).setFeeRecipient(newRecipient))
        .to.emit(dashboard, "FeeRecipientSet")
        .withArgs(nodeOperatorManager, currentRecipient, newRecipient);

      await mEqual([[dashboard.feeRecipient(), newRecipient]]);

      // Change back
      await expect(dashboard.connect(nodeOperatorManager).setFeeRecipient(currentRecipient))
        .to.emit(dashboard, "FeeRecipientSet")
        .withArgs(nodeOperatorManager, newRecipient, currentRecipient);

      await mEqual([[dashboard.feeRecipient(), currentRecipient]]);
    });

    it("changes fee rate with dual confirmation", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const currentFeeRate = await dashboard.feeRate();
      const newFeeRate = currentFeeRate + 1_00n; // +1%

      // First confirmation from node operator manager - returns false (pending)
      expect(await dashboard.connect(nodeOperatorManager).setFeeRate.staticCall(newFeeRate)).to.equal(false);

      // Should NOT emit FeeRateSet yet (only pending)
      await expect(dashboard.connect(nodeOperatorManager).setFeeRate(newFeeRate)).to.not.emit(dashboard, "FeeRateSet");
      await mEqual([[dashboard.feeRate(), currentFeeRate]]); // Not changed yet

      // Second confirmation from vault owner - returns true (applied)
      expect(await dashboard.connect(vaultOwner).setFeeRate.staticCall(newFeeRate)).to.equal(true);

      await expect(dashboard.connect(vaultOwner).setFeeRate(newFeeRate))
        .to.emit(dashboard, "FeeRateSet")
        .withArgs(vaultOwner, currentFeeRate, newFeeRate);

      await mEqual([[dashboard.feeRate(), newFeeRate]]);
    });

    it("adds fee exemption manually", async () => {
      const settledGrowthBefore = await dashboard.settledGrowth();
      const latestCorrectionTimestampBefore = await dashboard.latestCorrectionTimestamp();
      const feeRateBefore = await dashboard.feeRate();
      const exemptionAmount = ether("0.5");

      // nodeOperatorManager can call addFeeExemption because they are admin of NODE_OPERATOR_FEE_EXEMPT_ROLE
      const addExemptionTx = dashboard.connect(nodeOperatorManager).addFeeExemption(exemptionAmount);
      await expect(addExemptionTx)
        .to.emit(dashboard, "SettledGrowthSet")
        .withArgs(settledGrowthBefore, settledGrowthBefore + exemptionAmount);
      await expect(addExemptionTx).to.emit(dashboard, "CorrectionTimestampUpdated");

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
      const correctGrowthTx = dashboard
        .connect(vaultOwner)
        .correctSettledGrowth(newSettledGrowth, currentSettledGrowth);
      await expect(correctGrowthTx)
        .to.emit(dashboard, "SettledGrowthSet")
        .withArgs(currentSettledGrowth, newSettledGrowth);
      await expect(correctGrowthTx).to.emit(dashboard, "CorrectionTimestampUpdated");

      // Verify changes applied
      await mEqual([[dashboard.settledGrowth(), newSettledGrowth]]);

      // Verify correction timestamp updated
      const latestCorrectionTimestampAfter = await dashboard.latestCorrectionTimestamp();
      expect(latestCorrectionTimestampAfter).to.be.gt(latestCorrectionTimestampBefore);
    });

    // ==================== Part 8: Tier Changes Work (with PDG paused) ====================

    it("changes tier", async () => {
      const settledGrowthBefore = await dashboard.settledGrowth();
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const tierAltShareLimit = ether("800");

      // Node operator confirms tier change first (partial approval - no event yet)
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, OPERATOR_GROUP_TIER_2_ID, tierAltShareLimit);

      // Vault owner completes tier change (emits events)
      await expect(dashboard.connect(vaultOwner).changeTier(OPERATOR_GROUP_TIER_2_ID, tierAltShareLimit))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          stakingVault,
          nodeOperator,
          tierAltShareLimit,
          OPERATOR_GROUP_TIER_2_PARAMS.reserveRatioBP,
          OPERATOR_GROUP_TIER_2_PARAMS.forcedRebalanceThresholdBP,
        )
        .and.to.emit(operatorGrid, "TierChanged")
        .withArgs(stakingVault, OPERATOR_GROUP_TIER_2_ID, tierAltShareLimit);

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

      // Node operator confirms tier change first (partial approval - no event yet)
      await operatorGrid
        .connect(nodeOperator)
        .changeTier(stakingVault, OPERATOR_GROUP_TIER_1_ID, tierPrimaryShareLimit);

      // Vault owner completes tier change (emits events)
      await expect(dashboard.connect(vaultOwner).changeTier(OPERATOR_GROUP_TIER_1_ID, tierPrimaryShareLimit))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          stakingVault,
          nodeOperator,
          tierPrimaryShareLimit,
          OPERATOR_GROUP_TIER_1_PARAMS.reserveRatioBP,
          OPERATOR_GROUP_TIER_1_PARAMS.forcedRebalanceThresholdBP,
        )
        .and.to.emit(operatorGrid, "TierChanged")
        .withArgs(stakingVault, OPERATOR_GROUP_TIER_1_ID, tierPrimaryShareLimit);

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

      await expect(dashboard.connect(vaultOwner).updateShareLimit(newShareLimit))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          stakingVault,
          nodeOperator,
          newShareLimit,
          OPERATOR_GROUP_TIER_1_PARAMS.reserveRatioBP,
          OPERATOR_GROUP_TIER_1_PARAMS.forcedRebalanceThresholdBP,
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
      const PROVE_ROLE = await dashboard.NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE();
      await expect(dashboard.connect(nodeOperatorManager).grantRole(PROVE_ROLE, nodeOperatorManager))
        .to.emit(dashboard, "RoleGranted")
        .withArgs(PROVE_ROLE, nodeOperatorManager, nodeOperatorManager);

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
      const liabilitySharesBefore = await vaultHub.liabilityShares(stakingVault);

      await expect(dashboard.connect(vaultOwner).mintShares(vaultOwner, sharesToMint)).to.emit(
        vaultHub,
        "MintedSharesOnVault",
      );

      // Verify minting worked
      await mEqual([[vaultHub.liabilityShares(stakingVault), liabilitySharesBefore + sharesToMint]]);

      expect(await lido.balanceOf(vaultOwner)).to.equalStETH(stETHBalanceBefore + stETHToReceive);

      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      expect(liabilityShares).to.be.gt(0n);

      const stETHNeeded = await lido.getPooledEthByShares(liabilityShares);

      // Approve and rebalance
      await expect(lido.connect(vaultOwner).approve(dashboard, stETHNeeded))
        .to.emit(lido, "Approval")
        .withArgs(vaultOwner, dashboard, stETHNeeded);

      // VaultRebalanced(vault, sharesBurned, etherWithdrawn)
      await expect(dashboard.connect(vaultOwner).rebalanceVaultWithShares(liabilityShares)).to.emit(
        vaultHub,
        "VaultRebalanced",
      );

      await mEqual([
        // Liability cleared
        [vaultHub.liabilityShares(stakingVault), 0n],
        // Vault remains healthy
        [vaultHub.isVaultHealthy(stakingVault), true],
        [vaultHub.isVaultConnected(stakingVault), true],
      ]);
    });

    it("handles slashing and force rebalance by stranger", async () => {
      const preSlashingSnapshot = await Snapshot.take();

      // Get a fresh report to ensure consistent state
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const totalValueBefore = await vaultHub.totalValue(stakingVault);

      // Step 1: Mint stETH to exactly max capacity (90% of totalValue for tier 1)
      // This puts the vault right at the reserve ratio threshold
      const totalMintable = await dashboard.remainingMintingCapacityShares(0n);
      expect(totalMintable).to.be.gt(0n);

      await dashboard.connect(vaultOwner).mintShares(vaultOwner, totalMintable);

      // Verify we're at max capacity
      expect(await dashboard.remainingMintingCapacityShares(0n)).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true);

      // Step 2: Simulate slashing - small slash (1%) will breach threshold when at max capacity
      // At max capacity: liability = 90% of totalValue, reserve = 10%
      // Unhealthy when: liability > totalValue * 0.9025 (9.75% reserve threshold)
      // With 1% slash: new reserve = (0.99 * totalValue - 0.9 * totalValue) / (0.99 * totalValue) = 9.09% < 9.75%
      const slashPercent = 1n;
      const slashedTotalValue = (totalValueBefore * (100n - slashPercent)) / 100n;

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: slashedTotalValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Verify vault is now unhealthy
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(false);

      // Check obligations - sharesToBurn should be > 0
      const [sharesToBurn] = await vaultHub.obligations(stakingVault);
      expect(sharesToBurn).to.be.gt(0n);

      // Step 3: Stranger executes force rebalance
      const liabilitySharesBeforeRebalance = await vaultHub.liabilityShares(stakingVault);

      // Force rebalance - anyone can call this when vault is unhealthy
      await expect(vaultHub.connect(stranger).forceRebalance(stakingVault)).to.emit(vaultHub, "VaultRebalanced");

      // Step 4: Verify vault is healthy after force rebalance
      const liabilitySharesAfterForce = await vaultHub.liabilityShares(stakingVault);

      await mEqual([
        // Liability shares reduced
        [liabilitySharesAfterForce < liabilitySharesBeforeRebalance, true],
        // Vault is now healthy
        [vaultHub.isVaultHealthy(stakingVault), true],
        // Vault still connected
        [vaultHub.isVaultConnected(stakingVault), true],
      ]);

      // Verify no more force rebalance needed (obligations should be 0)
      const [remainingObligations] = await vaultHub.obligations(stakingVault);
      expect(remainingObligations).to.equal(0n);

      await Snapshot.restore(preSlashingSnapshot);
    });

    it("pays Lido fees via settleLidoFees", async () => {
      // Get fresh report and current state
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const treasury = await ctx.contracts.locator.treasury();
      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury);

      // Get current Lido fees state
      const vaultRecord = await vaultHub.vaultRecord(stakingVault);
      const settledLidoFeesBefore = vaultRecord.settledLidoFees;

      // Report with cumulative Lido fees (simulates fees accrued over time)
      const lidoFeesAmount = ether("2");
      const newCumulativeLidoFees = settledLidoFeesBefore + lidoFeesAmount;

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore,
        cumulativeLidoFees: newCumulativeLidoFees,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Verify unsettled fees exist via obligations
      const [, feesToSettle] = await vaultHub.obligations(stakingVault);
      expect(feesToSettle).to.equal(lidoFeesAmount);

      // Step 2: Stranger settles Lido fees (permissionless)
      await expect(vaultHub.connect(stranger).settleLidoFees(stakingVault))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVault, lidoFeesAmount, newCumulativeLidoFees, newCumulativeLidoFees);

      // Verify fees were transferred to treasury
      await mEqual([[ethers.provider.getBalance(treasury), treasuryBalanceBefore + lidoFeesAmount]]);

      // Verify no more fees to settle
      const [, feesAfter] = await vaultHub.obligations(stakingVault);
      expect(feesAfter).to.equal(0n);

      vaultTotalValue = await vaultHub.totalValue(stakingVault);
    });

    it("settles redemptions via setLiabilitySharesTarget", async () => {
      // Get fresh report
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      // Step 1: Mint some shares to create liability
      const sharesToMint = ether("10");
      await dashboard.connect(vaultOwner).mintShares(vaultOwner, sharesToMint);

      const liabilitySharesBefore = await vaultHub.liabilityShares(stakingVault);
      expect(liabilitySharesBefore).to.be.gte(sharesToMint);

      // Get fresh report after minting
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      // Step 2: DAO sets redemption target (mark part of liability as redemption shares)
      // This simulates Lido Core needing to redeem stETH from vaults
      const redemptionAmount = sharesToMint / 2n; // Mark half as redemption
      const liabilityTarget = liabilitySharesBefore - redemptionAmount;

      // Grant REDEMPTION_MASTER_ROLE to agent if not already granted
      const REDEMPTION_MASTER_ROLE = await vaultHub.REDEMPTION_MASTER_ROLE();
      await vaultHub.connect(agent).grantRole(REDEMPTION_MASTER_ROLE, agent.address);

      await expect(vaultHub.connect(agent).setLiabilitySharesTarget(stakingVault, liabilityTarget))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVault, redemptionAmount);

      // Verify redemption shares are set
      const vaultRecord = await vaultHub.vaultRecord(stakingVault);
      expect(vaultRecord.redemptionShares).to.equal(redemptionAmount);

      // Verify obligations include redemption shares
      const [sharesToBurn] = await vaultHub.obligations(stakingVault);
      expect(sharesToBurn).to.be.gte(redemptionAmount);

      // Step 3: Vault owner settles redemptions by rebalancing
      const stETHNeeded = await lido.getPooledEthByShares(redemptionAmount);
      await lido.connect(vaultOwner).approve(dashboard, stETHNeeded);
      await dashboard.connect(vaultOwner).rebalanceVaultWithShares(redemptionAmount);

      // Verify redemption shares decreased
      const vaultRecordAfter = await vaultHub.vaultRecord(stakingVault);
      expect(vaultRecordAfter.redemptionShares).to.equal(0n);

      // Verify obligations are cleared
      const [remainingObligations] = await vaultHub.obligations(stakingVault);
      expect(remainingObligations).to.equal(0n);

      // Clean up: burn remaining liability shares for subsequent tests
      const remainingLiability = await vaultHub.liabilityShares(stakingVault);
      if (remainingLiability > 0n) {
        const stETHForCleanup = await lido.getPooledEthByShares(remainingLiability);
        await lido.connect(vaultOwner).approve(dashboard, stETHForCleanup);
        await dashboard.connect(vaultOwner).burnShares(remainingLiability);
      }

      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);
      vaultTotalValue = await vaultHub.totalValue(stakingVault);
    });

    it("disconnects vault", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const accruedFeeBefore = await dashboard.accruedFee();

      await expect(dashboard.connect(vaultOwner).voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVault);

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

      // Recover fee leftover to fee recipient
      if (feeLeftover > 0n) {
        const feeRecipient = await dashboard.feeRecipient();
        const feeRecipientBalanceBefore = await ethers.provider.getBalance(feeRecipient);

        await dashboard.connect(nodeOperatorManager).recoverFeeLeftover();

        await mEqual([
          [dashboard.feeLeftover(), 0n],
          [ethers.provider.getBalance(feeRecipient), feeRecipientBalanceBefore + feeLeftover],
        ]);
      }
    });

    it("reconnects vault to VaultHub", async () => {
      // Correct settled growth to zero for reconnection
      // This is required because settledGrowth is set to MAX during disconnect
      const currentSettledGrowth = await dashboard.settledGrowth();
      if (currentSettledGrowth !== 0n) {
        // First confirmation (should NOT emit SettledGrowthSet yet)
        await expect(dashboard.connect(nodeOperatorManager).correctSettledGrowth(0n, currentSettledGrowth)).to.not.emit(
          dashboard,
          "SettledGrowthSet",
        );

        // Second confirmation (should emit events)
        const correctGrowthReconnectTx = dashboard.connect(vaultOwner).correctSettledGrowth(0n, currentSettledGrowth);
        await expect(correctGrowthReconnectTx)
          .to.emit(dashboard, "SettledGrowthSet")
          .withArgs(currentSettledGrowth, 0n);
        await expect(correctGrowthReconnectTx).to.emit(dashboard, "CorrectionTimestampUpdated");
      }
      expect(await dashboard.settledGrowth()).to.equal(0n);

      // Reconnect
      await expect(dashboard.connect(vaultOwner).reconnectToVaultHub()).to.emit(vaultHub, "VaultConnected");

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
        await expect(dashboard.connect(vaultOwner).burnShares(liabilityShares))
          .to.emit(vaultHub, "BurnedSharesOnVault")
          .withArgs(stakingVault, liabilityShares);
      }
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);

      await expect(dashboard.connect(vaultOwner).voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVault);

      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.equal(true);

      await expect(reportVaultDataWithProof(ctx, stakingVault))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

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
      expect(await stakingVault.pendingOwner()).to.equal(dashboard);
      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);

      // Abandon dashboard to transfer vault ownership to owner
      // abandonDashboard internally calls acceptOwnership then transfers to new owner
      await expect(dashboard.connect(vaultOwner).abandonDashboard(vaultOwner))
        .to.emit(stakingVault, "OwnershipTransferStarted")
        .withArgs(dashboard, vaultOwner);

      await mEqual([
        // Pending ownership transfer
        [stakingVault.pendingOwner(), vaultOwner],
        // Current owner still dashboard until acceptance
        [stakingVault.owner(), dashboard],
      ]);

      // Owner accepts ownership
      await expect(stakingVault.connect(vaultOwner).acceptOwnership())
        .to.emit(stakingVault, "OwnershipTransferred")
        .withArgs(dashboard, vaultOwner);

      await mEqual([
        // Ownership transferred
        [stakingVault.owner(), vaultOwner],
        [stakingVault.pendingOwner(), ethers.ZeroAddress],
        // Vault still disconnected
        [vaultHub.isVaultConnected(stakingVault), false],
      ]);

      // Verify vault is not ossified yet
      const proxy = await ethers.getContractAt("PinnedBeaconProxy", stakingVault);
      expect(await proxy.isOssified()).to.equal(false);

      // Ossify the vault
      await expect(stakingVault.connect(vaultOwner).ossify())
        .to.emit(stakingVault, "PinnedImplementationUpdated")
        .withArgs(await ctx.contracts.stakingVaultBeacon.implementation());

      // Verify ossification
      expect(await proxy.isOssified()).to.equal(true);

      // Verify vault basic functionality still works (read-only)
      expect(await stakingVault.nodeOperator()).to.equal(nodeOperator);
      expect(await stakingVault.depositor()).to.equal(predepositGuarantee);

      // Verify vault cannot reconnect after ossification
      // Transfer ownership to VaultHub (first step of reconnection)
      await stakingVault.connect(vaultOwner).transferOwnership(vaultHub);
      expect(await stakingVault.pendingOwner()).to.equal(await vaultHub.getAddress());

      // VaultHub.connectVault reverts because vault is ossified
      await expect(vaultHub.connect(vaultOwner).connectVault(stakingVault)).to.be.revertedWithCustomError(
        vaultHub,
        "VaultOssified",
      );
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
      const record = await vaultHub.vaultRecord(vault);
      const [cache0, cache1] = record.inOutDelta;
      return cache0.refSlot >= cache1.refSlot ? cache0.value : cache1.value;
    }
  }),
);
