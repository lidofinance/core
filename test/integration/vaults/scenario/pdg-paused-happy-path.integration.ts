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

    const createValidators = (count: number): ValidatorInfo[] =>
      Array.from({ length: count }, () => ({ ...generateValidator(withdrawalCredentials), index: 0, proof: [] }));

    const addValidatorsToTree = async (validators: ValidatorInfo[]) => {
      if (!mockCLtree) throw new Error("mockCLtree not initialized");
      for (const validator of validators) {
        validator.index = (await mockCLtree.addValidator(validator.container)).validatorIndex;
      }
    };

    const commitAndProveValidators = async (validators: ValidatorInfo[], slotOffset: number) => {
      if (!mockCLtree) throw new Error("mockCLtree not initialized");

      ({ childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(
        Number(slot) + slotOffset,
      ));

      for (const validator of validators) {
        validator.proof = await mockCLtree.buildProof(validator.index, beaconBlockHeader);
      }

      return { header: beaconBlockHeader, timestamp: childBlockTimestamp };
    };

    const toWitnesses = (
      validators: ValidatorInfo[],
      header: SSZBLSHelpers.BeaconBlockHeaderStruct,
      timestamp: number,
    ) =>
      validators.map((validator) => ({
        proof: validator.proof,
        pubkey: hexlify(validator.container.pubkey),
        validatorIndex: validator.index,
        childBlockTimestamp: timestamp,
        slot: header.slot,
        proposerIndex: header.proposerIndex,
      }));

    async function currentInOutDelta(vault: StakingVault): Promise<bigint> {
      const record = await vaultHub.vaultRecord(await vault.getAddress());
      const [cache0, cache1] = record.inOutDelta;
      return cache0.refSlot >= cache1.refSlot ? cache0.value : cache1.value;
    }

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

    it("creates vault with immediate connection via createVaultWithDashboard (alternate path)", async () => {
      // Snapshot before alternate path
      const snapshotBeforeAlternatePath = await Snapshot.take();

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
      ]);

      // Revert to continue with two-step connection path
      await Snapshot.restore(snapshotBeforeAlternatePath);
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
        [stakingVaultFactory.deployedVaults(stakingVault), true],
        [vaultHub.isVaultConnected(stakingVault), false],
        [stakingVault.nodeOperator(), nodeOperator],
        [stakingVault.owner(), dashboard],
        [stakingVault.depositor(), predepositGuarantee],
        [dashboard.hasRole(await dashboard.DEFAULT_ADMIN_ROLE(), vaultOwner), true],
        [dashboard.hasRole(await dashboard.NODE_OPERATOR_MANAGER_ROLE(), nodeOperatorManager), true],
        [dashboard.pdgPolicy(), PDGPolicy.STRICT],
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

      await mEqual([
        [vaultHub.isVaultConnected(stakingVault), true],
        [vaultHub.isVaultHealthy(stakingVault), true],
        [vaultHub.totalValue(stakingVault), vaultTotalValue],
        [currentInOutDelta(stakingVault), vaultTotalValue],
        [vaultHub.locked(stakingVault), VAULT_CONNECTION_DEPOSIT],
      ]);
    });

    it("funds vault", async () => {
      await dashboard.connect(vaultOwner).fund({ value: fundAmount });
      vaultTotalValue += fundAmount;

      await mEqual([
        [stakingVault.availableBalance(), vaultTotalValue],
        [currentInOutDelta(stakingVault), vaultTotalValue],
        [vaultHub.totalValue(stakingVault), vaultTotalValue],
      ]);
    });

    // ==================== Part 2: Verify All PDG Operations Are Blocked ====================

    it("blocks PDG predeposit when paused", async () => {
      const validator = createValidators(1)[0];
      const depositDomain = await predepositGuarantee.DEPOSIT_DOMAIN();
      const predeposit = await generatePredeposit(validator, { depositDomain });

      await expect(
        predepositGuarantee.connect(nodeOperator).predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("blocks PDG topUpNodeOperatorBalance when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") }),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("blocks PDG setNodeOperatorGuarantor when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(stranger),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("blocks PDG setNodeOperatorDepositor when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(stranger),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("blocks PDG claimGuarantorRefund when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).claimGuarantorRefund(nodeOperator),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("blocks PDG proveWCAndActivate when paused", async () => {
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

    it("blocks PDG activateValidator when paused", async () => {
      const mockPubkey = "0x" + "00".repeat(48);

      await expect(
        predepositGuarantee.connect(nodeOperator).activateValidator(mockPubkey),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("blocks PDG topUpExistingValidators when paused", async () => {
      const mockPubkey = "0x" + "00".repeat(48);

      await expect(
        predepositGuarantee.connect(nodeOperator).topUpExistingValidators([{ pubkey: mockPubkey, amount: ether("1") }]),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("blocks PDG proveWCActivateAndTopUpValidators when paused", async () => {
      await expect(
        predepositGuarantee.connect(nodeOperator).proveWCActivateAndTopUpValidators([], []),
      ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
    });

    it("blocks PDG proveUnknownValidator when paused", async () => {
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

    it("blocks PDG proveInvalidValidatorWC when paused", async () => {
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

      await dashboard.connect(vaultOwner).fund({ value: additionalFund });
      vaultTotalValue += additionalFund;

      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore + additionalFund],
        [stakingVault.availableBalance(), vaultTotalValue],
      ]);
    });

    it("allows mint shares", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const sharesToMint = ether("10");
      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);

      await dashboard.connect(vaultOwner).mintShares(vaultOwner, sharesToMint);

      await mEqual([[vaultHub.liabilityShares(stakingVault), liabilityBefore + sharesToMint]]);
    });

    it("allows burn shares", async () => {
      const sharesToBurn = ether("5");
      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);

      await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(sharesToBurn));
      await dashboard.connect(vaultOwner).burnShares(sharesToBurn);

      await mEqual([[vaultHub.liabilityShares(stakingVault), liabilityBefore - sharesToBurn]]);
    });

    it("allows withdraw", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const withdrawAmount = ether("5");
      const balanceBefore = await ethers.provider.getBalance(vaultOwner);
      const withdrawable = await dashboard.withdrawableValue();

      expect(withdrawable).to.be.gte(withdrawAmount);

      const tx = await dashboard.connect(vaultOwner).withdraw(vaultOwner, withdrawAmount);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasPrice * receipt!.gasUsed;

      vaultTotalValue -= withdrawAmount;

      const balanceAfter = await ethers.provider.getBalance(vaultOwner);
      expect(balanceAfter).to.equal(balanceBefore + withdrawAmount - gasCost);
    });

    // ==================== Part 4: Unguaranteed Deposits Work ====================

    it("sets PDG policy for unguaranteed deposits", async () => {
      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.STRICT]]);

      await dashboard.connect(vaultOwner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);

      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.ALLOW_DEPOSIT_AND_PROVE]]);
    });

    it("grants unguaranteed deposit role to node operator manager", async () => {
      await dashboard
        .connect(nodeOperatorManager)
        .grantRole(await dashboard.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE(), nodeOperatorManager);

      await mEqual([
        [dashboard.hasRole(await dashboard.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE(), nodeOperatorManager), true],
      ]);
    });

    it("makes unguaranteed deposit", async () => {
      const validator = createValidators(1)[0];
      unguaranteedValidators.push(validator);

      const deposit = generateDepositStruct(validator.container, minActiveValidatorBalance);

      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);

      // Unguaranteed deposit bypasses PDG - deposits directly to beacon chain
      await dashboard.connect(nodeOperatorManager).unguaranteedDepositToBeaconChain([deposit]);

      vaultTotalValue -= minActiveValidatorBalance;

      // Total value decreases (validator not yet reported)
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore - minActiveValidatorBalance],
        [currentInOutDelta(stakingVault), inOutDeltaBefore - minActiveValidatorBalance],
        [lazyOracle.quarantineValue(stakingVault), 0n], // quarantine not kicked in yet
      ]);
    });

    it("reports unguaranteed validator to quarantine", async () => {
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);

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
      ]);
    });

    it("releases unguaranteed validator from quarantine after waiting period", async () => {
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      const quarantinedValue = await lazyOracle.quarantineValue(stakingVault);
      const totalValueBefore = await vaultHub.totalValue(stakingVault);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + quarantinedValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      vaultTotalValue += minActiveValidatorBalance;

      // Quarantine released - total value increased
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore + quarantinedValue],
        [lazyOracle.quarantineValue(stakingVault), 0n],
      ]);
    });

    // ==================== Part 5: Side Deposits Work ====================

    it("simulates side deposit (external validator appears)", async () => {
      const sideValidator = createValidators(1)[0];
      sideDepositedValidators.push(sideValidator);

      const sideDepositAmount = minActiveValidatorBalance;
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);

      // Add fee exemption to prevent side deposit being counted as rewards
      const settledGrowthBefore = await dashboard.settledGrowth();
      await dashboard.connect(nodeOperatorManager).addFeeExemption(sideDepositAmount);
      await mEqual([[dashboard.settledGrowth(), settledGrowthBefore + sideDepositAmount]]);

      // Report side deposit - will be quarantined
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + sideDepositAmount,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Value quarantined
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore],
        [currentInOutDelta(stakingVault), inOutDeltaBefore],
        [lazyOracle.quarantineValue(stakingVault), sideDepositAmount],
      ]);
    });

    it("releases side deposit from quarantine after waiting period", async () => {
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      const quarantinedValue = await lazyOracle.quarantineValue(stakingVault);
      const totalValueBefore = await vaultHub.totalValue(stakingVault);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + quarantinedValue,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      vaultTotalValue += minActiveValidatorBalance;

      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore + quarantinedValue],
        [lazyOracle.quarantineValue(stakingVault), 0n],
      ]);
    });

    // ==================== Part 6: Tier Changes Work ====================

    it("changes tier", async () => {
      // Burn all shares first (tier 2 has higher reserve ratio)
      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      if (liabilityShares > 0n) {
        await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(liabilityShares));
        await dashboard.connect(vaultOwner).burnShares(liabilityShares);
      }
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);

      const tierAltShareLimit = ether("800");

      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, OPERATOR_GROUP_TIER_2_ID, tierAltShareLimit);
      await expect(dashboard.connect(vaultOwner).changeTier(OPERATOR_GROUP_TIER_2_ID, tierAltShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const [, tierAfterId, tierAfterShareLimit] = await operatorGrid.vaultTierInfo(stakingVault);
      await mEqual([
        [tierAfterId, OPERATOR_GROUP_TIER_2_ID],
        [tierAfterShareLimit, OPERATOR_GROUP_TIER_2_PARAMS.shareLimit],
      ]);
    });

    it("changes tier back", async () => {
      const tierPrimaryShareLimit = ether("900");
      await operatorGrid
        .connect(nodeOperator)
        .changeTier(stakingVault, OPERATOR_GROUP_TIER_1_ID, tierPrimaryShareLimit);
      await expect(dashboard.connect(vaultOwner).changeTier(OPERATOR_GROUP_TIER_1_ID, tierPrimaryShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const [, tierFinalId] = await operatorGrid.vaultTierInfo(stakingVault);
      await mEqual([[tierFinalId, OPERATOR_GROUP_TIER_1_ID]]);
    });

    it("updates share limit", async () => {
      const newShareLimit = ether("600");
      await operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, newShareLimit);
      await expect(dashboard.connect(vaultOwner).updateShareLimit(newShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const connection = await vaultHub.vaultConnection(stakingVault);
      await mEqual([[connection.shareLimit, newShareLimit]]);
    });

    // ==================== Part 7: Prove Validators is Blocked ====================

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

    // ==================== Part 8: Rebalance, Disconnect, Reconnect, and Ossify ====================

    it("rebalances vault", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const sharesToMint = ether("5");
      await dashboard.connect(vaultOwner).mintShares(vaultOwner, sharesToMint);

      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      await dashboard.connect(vaultOwner).rebalanceVaultWithShares(liabilityShares);

      await mEqual([[vaultHub.liabilityShares(stakingVault), 0n]]);
    });

    it("disconnects vault", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.equal(true);

      await expect(reportVaultDataWithProof(ctx, stakingVault))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);
    });

    it("reconnects vault to VaultHub", async () => {
      // Recover any fee leftover first
      const feeLeftover = await dashboard.feeLeftover();
      if (feeLeftover > 0n) {
        await dashboard.connect(nodeOperatorManager).recoverFeeLeftover();
        expect(await dashboard.feeLeftover()).to.equal(0n);
      }

      // Correct settled growth to zero for reconnection
      const currentSettledGrowth = await dashboard.settledGrowth();
      if (currentSettledGrowth > 0n) {
        await dashboard.connect(nodeOperatorManager).correctSettledGrowth(0n, currentSettledGrowth);
        await dashboard.connect(vaultOwner).correctSettledGrowth(0n, currentSettledGrowth);
      }
      expect(await dashboard.settledGrowth()).to.equal(0n);

      // Reconnect
      await dashboard.connect(vaultOwner).reconnectToVaultHub();

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(true);
    });

    it("disconnects vault again for ossification test", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      // Burn all liability shares if any
      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      if (liabilityShares > 0n) {
        await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(liabilityShares));
        await dashboard.connect(vaultOwner).burnShares(liabilityShares);
      }

      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);
    });

    it("ossifies vault after abandoning dashboard", async () => {
      // Abandon dashboard to transfer vault ownership to stranger
      await dashboard.connect(vaultOwner).abandonDashboard(stranger.address);
      expect(await stakingVault.pendingOwner()).to.equal(stranger.address);

      // Stranger accepts ownership
      await stakingVault.connect(stranger).acceptOwnership();
      expect(await stakingVault.owner()).to.equal(stranger.address);

      // Ossify the vault
      await stakingVault.connect(stranger).ossify();

      // Verify ossification
      const proxy = await ethers.getContractAt("PinnedBeaconProxy", stakingVault);
      expect(await proxy.isOssified()).to.equal(true);
    });
  }),
);
