import { expect } from "chai";
import { hexlify } from "ethers";
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
  certainAddress,
  days,
  ether,
  generateDepositStruct,
  generatePredeposit,
  generateValidator,
  LocalMerkleTree,
  PDGPolicy,
  prepareLocalMerkleTree,
} from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";
import { mEqual } from "lib/promise";
import {
  createVaultProxyWithoutConnectingToVaultHub,
  getProtocolContext,
  getReportTimeElapsed,
  ProtocolContext,
  reportVaultDataWithProof,
  reportVaultsDataWithProof,
  setupLidoForVaults,
  VAULT_CONNECTION_DEPOSIT,
} from "lib/protocol";

import { resetState, Snapshot } from "test/suite";
import { ONE_DAY } from "test/suite/constants";

const ONE_YEAR = 365n * ONE_DAY;

const VAULT_NODE_OPERATOR_FEE = 5_00n;
const CONFIRM_EXPIRY = days(7n);

const OPERATOR_GROUP_SHARE_LIMIT = ether("1500");
const OPERATOR_GROUP_INFRA_FEE_BP = 1_00n;
const OPERATOR_GROUP_LIQUIDITY_FEE_BP = 6_00n;
const OPERATOR_GROUP_RESERVATION_FEE_BP = 50n;

const TIER_1_ID = 1n;
const TIER_1_PARAMS: TierParamsStruct = {
  shareLimit: ether("1000"),
  reserveRatioBP: 10_00n,
  forcedRebalanceThresholdBP: 9_75n,
  infraFeeBP: OPERATOR_GROUP_INFRA_FEE_BP,
  liquidityFeeBP: OPERATOR_GROUP_LIQUIDITY_FEE_BP,
  reservationFeeBP: OPERATOR_GROUP_RESERVATION_FEE_BP,
};

const TIER_2_ID = 2n;
const TIER_2_PARAMS: TierParamsStruct = {
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

enum ValidatorStage {
  NONE = 0,
  PREDEPOSITED = 1,
  PROVEN = 2,
  ACTIVATED = 3,
  COMPENSATED = 4,
}

resetState(
  describe("Scenario: Node Operator Happy Path", () => {
    let ctx: ProtocolContext;

    // EOAs
    let vaultOwner: HardhatEthersSigner;
    let nodeOperator: HardhatEthersSigner;
    let nodeOperatorManager: HardhatEthersSigner;
    let guarantor: HardhatEthersSigner;
    let unguaranteedDepositor: HardhatEthersSigner;
    let stranger: HardhatEthersSigner;
    let delegatedDepositor: HardhatEthersSigner;
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
    let depositDomain: string;
    let activationDepositAmount: bigint;
    let mockCLtree: LocalMerkleTree | undefined;
    let slot: bigint;
    let childBlockTimestamp: number;
    let beaconBlockHeader: SSZBLSHelpers.BeaconBlockHeaderStruct;
    let nodeOperatorBalance = 0n;
    const minActiveValidatorBalance = ether("32");

    // Validator types
    let guaranteedValidators: ValidatorInfo[] = [];

    const fundAmount = ether("150");

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

    before(async () => {
      [
        ,
        vaultOwner,
        nodeOperator,
        nodeOperatorManager,
        guarantor,
        unguaranteedDepositor,
        stranger,
        delegatedDepositor,
        agent,
      ] = await ethers.getSigners();

      ctx = await getProtocolContext();
      ({ vaultHub, operatorGrid, predepositGuarantee, stakingVaultFactory, lido, lazyOracle } = ctx.contracts);

      agent = await ctx.getSigner("agent");

      await setupLidoForVaults(ctx);
      await setBalance(nodeOperator.address, ether("100"));

      slot = await predepositGuarantee.PIVOT_SLOT();
      mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_CURR());
      depositDomain = await predepositGuarantee.DEPOSIT_DOMAIN();
      activationDepositAmount = await predepositGuarantee.ACTIVATION_DEPOSIT_AMOUNT();
    });

    it("creates a StakingVault and Dashboard", async () => {
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
        [dashboard.feeRecipient(), nodeOperatorManager],
        [dashboard.feeRate(), VAULT_NODE_OPERATOR_FEE],
        [dashboard.getConfirmExpiry(), CONFIRM_EXPIRY],
        [dashboard.settledGrowth(), 0n],
        [dashboard.latestCorrectionTimestamp(), 0n],
        [dashboard.accruedFee(), 0n],
        [dashboard.feeLeftover(), 0n],
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
      await operatorGrid.connect(agent).registerTiers(nodeOperator, [TIER_1_PARAMS, TIER_2_PARAMS]);

      const group = await operatorGrid.group(nodeOperator);
      await mEqual([
        [group.tierIds.length, 2],
        [group.shareLimit, OPERATOR_GROUP_SHARE_LIMIT],
      ]);

      const tier0 = await operatorGrid.tier(Number(TIER_1_ID));
      await mEqual([
        [tier0.operator, nodeOperator],
        [tier0.shareLimit, TIER_1_PARAMS.shareLimit],
        [tier0.reserveRatioBP, TIER_1_PARAMS.reserveRatioBP],
        [tier0.forcedRebalanceThresholdBP, TIER_1_PARAMS.forcedRebalanceThresholdBP],
        [tier0.infraFeeBP, TIER_1_PARAMS.infraFeeBP],
        [tier0.liquidityFeeBP, TIER_1_PARAMS.liquidityFeeBP],
        [tier0.reservationFeeBP, TIER_1_PARAMS.reservationFeeBP],
      ]);

      const tier1 = await operatorGrid.tier(Number(TIER_2_ID));
      await mEqual([
        [tier1.operator, nodeOperator],
        [tier1.shareLimit, TIER_2_PARAMS.shareLimit],
        [tier1.reserveRatioBP, TIER_2_PARAMS.reserveRatioBP],
        [tier1.forcedRebalanceThresholdBP, TIER_2_PARAMS.forcedRebalanceThresholdBP],
        [tier1.infraFeeBP, TIER_2_PARAMS.infraFeeBP],
        [tier1.liquidityFeeBP, TIER_2_PARAMS.liquidityFeeBP],
        [tier1.reservationFeeBP, TIER_2_PARAMS.reservationFeeBP],
      ]);
    });

    it("connects to VaultHub with tier 1", async () => {
      const tierInfoBeforeConnect = await operatorGrid.vaultTierInfo(stakingVault);
      await mEqual([
        [tierInfoBeforeConnect.tierId, operatorGrid.DEFAULT_TIER_ID()],
        [tierInfoBeforeConnect.nodeOperator, operatorGrid.DEFAULT_TIER_OPERATOR()],
      ]);

      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, TIER_1_ID, TIER_1_PARAMS.shareLimit);

      await dashboard
        .connect(vaultOwner)
        .connectAndAcceptTier(TIER_1_ID, TIER_1_PARAMS.shareLimit, { value: VAULT_CONNECTION_DEPOSIT });

      vaultTotalValue += VAULT_CONNECTION_DEPOSIT;

      await mEqual([
        [vaultHub.isVaultConnected(stakingVault), true],
        [vaultHub.isVaultHealthy(stakingVault), true],
        [vaultHub.totalValue(stakingVault), vaultTotalValue],
        [currentInOutDelta(stakingVault), vaultTotalValue],
        [vaultHub.obligations(stakingVault), [0n, 0n]],
        [vaultHub.locked(stakingVault), VAULT_CONNECTION_DEPOSIT],
        [vaultHub.liabilityShares(stakingVault), 0n],
        [vaultHub.vaultsCount(), 1],
      ]);

      const tierInfoAfterConnect = await operatorGrid.vaultTierInfo(stakingVault);
      await mEqual([
        [tierInfoAfterConnect.nodeOperator, nodeOperator],
        [tierInfoAfterConnect.tierId, TIER_1_ID],
        [tierInfoAfterConnect.shareLimit, TIER_1_PARAMS.shareLimit],
        [tierInfoAfterConnect.reserveRatioBP, TIER_1_PARAMS.reserveRatioBP],
        [tierInfoAfterConnect.forcedRebalanceThresholdBP, TIER_1_PARAMS.forcedRebalanceThresholdBP],
        [tierInfoAfterConnect.infraFeeBP, TIER_1_PARAMS.infraFeeBP],
        [tierInfoAfterConnect.liquidityFeeBP, TIER_1_PARAMS.liquidityFeeBP],
        [tierInfoAfterConnect.reservationFeeBP, TIER_1_PARAMS.reservationFeeBP],
      ]);

      const connectionAfterConnect = await vaultHub.vaultConnection(stakingVault);
      await mEqual([
        [connectionAfterConnect.shareLimit, TIER_1_PARAMS.shareLimit],
        [connectionAfterConnect.reserveRatioBP, TIER_1_PARAMS.reserveRatioBP],
        [connectionAfterConnect.forcedRebalanceThresholdBP, TIER_1_PARAMS.forcedRebalanceThresholdBP],
        [connectionAfterConnect.infraFeeBP, TIER_1_PARAMS.infraFeeBP],
        [connectionAfterConnect.liquidityFeeBP, TIER_1_PARAMS.liquidityFeeBP],
        [connectionAfterConnect.reservationFeeBP, TIER_1_PARAMS.reservationFeeBP],
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

    it("sets up node operator guarantor", async () => {
      await mEqual([[predepositGuarantee.nodeOperatorGuarantor(nodeOperator), nodeOperator]]);
      await predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(guarantor);
      await mEqual([[predepositGuarantee.nodeOperatorGuarantor(nodeOperator), guarantor]]);
    });

    it("tops up PDG node operator balance", async () => {
      await mEqual([
        [predepositGuarantee.nodeOperatorBalance(nodeOperator), [nodeOperatorBalance, nodeOperatorBalance]],
      ]);

      const predepositAmount = await predepositGuarantee.PREDEPOSIT_AMOUNT();

      await predepositGuarantee.connect(guarantor).topUpNodeOperatorBalance(nodeOperator, { value: predepositAmount });
      nodeOperatorBalance += predepositAmount;

      await mEqual([
        [predepositGuarantee.nodeOperatorBalance(nodeOperator), [nodeOperatorBalance, 0n]],
        [predepositGuarantee.unlockedBalance(nodeOperator), nodeOperatorBalance],
      ]);
    });

    it("performs a predeposit", async () => {
      guaranteedValidators = [...guaranteedValidators, ...createValidators(1)];

      const predeposits = await Promise.all(
        guaranteedValidators.map((validator) => generatePredeposit(validator, { depositDomain })),
      );

      await predepositGuarantee.connect(nodeOperator).predeposit(
        stakingVault,
        predeposits.map((p) => p.deposit),
        predeposits.map((p) => p.depositY),
      );

      const totalPredepositAmount = predeposits.reduce((acc, p) => acc + BigInt(p.deposit.amount), 0n);

      await mEqual([
        [predepositGuarantee.pendingActivations(stakingVault), BigInt(guaranteedValidators.length)],
        [
          stakingVault.stagedBalance(),
          BigInt(guaranteedValidators.length) * (await predepositGuarantee.ACTIVATION_DEPOSIT_AMOUNT()),
        ],
        [predepositGuarantee.nodeOperatorBalance(nodeOperator), [nodeOperatorBalance, totalPredepositAmount]],
        [predepositGuarantee.unlockedBalance(nodeOperator), nodeOperatorBalance - totalPredepositAmount],
      ]);
    });

    it("performs validator activation and top up", async () => {
      await addValidatorsToTree(guaranteedValidators);
      const { header, timestamp } = await commitAndProveValidators(guaranteedValidators, 100);
      const witnesses = toWitnesses(guaranteedValidators, header, timestamp);

      const topUpAmounts = guaranteedValidators.map(() => ether("31"));
      await predepositGuarantee.connect(nodeOperator).proveWCActivateAndTopUpValidators(witnesses, topUpAmounts);

      await mEqual([
        [predepositGuarantee.pendingActivations(stakingVault), 0n],
        [stakingVault.stagedBalance(), 0n],
        [vaultHub.totalValue(stakingVault), vaultTotalValue],
        [currentInOutDelta(stakingVault), vaultTotalValue],
      ]);
    });

    it("sets an unguaranteed depositor", async () => {
      await dashboard
        .connect(nodeOperatorManager)
        .grantRole(await dashboard.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE(), unguaranteedDepositor);

      await mEqual([
        [dashboard.hasRole(await dashboard.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE(), unguaranteedDepositor), true],
      ]);
    });

    it("rejects unguaranteed deposits under strict policy", async () => {
      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.STRICT]]);

      const validator = generateValidator(withdrawalCredentials);
      const deposit = generateDepositStruct(validator.container, activationDepositAmount);
      await expect(
        dashboard.connect(nodeOperator).unguaranteedDepositToBeaconChain([deposit]),
      ).to.be.revertedWithCustomError(dashboard, "ForbiddenByPDGPolicy");
    });

    it("processes an unguaranteed validator", async () => {
      await dashboard.connect(vaultOwner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);
      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.ALLOW_DEPOSIT_AND_PROVE]]);

      const unguaranteedValidator = createValidators(1)[0];
      const unguaranteedDeposit = generateDepositStruct(unguaranteedValidator.container, minActiveValidatorBalance);

      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);

      await dashboard.connect(nodeOperatorManager).unguaranteedDepositToBeaconChain([unguaranteedDeposit]);

      let expectedTotalValue = totalValueBefore - minActiveValidatorBalance;
      const expectedInOutDelta = inOutDeltaBefore - minActiveValidatorBalance;

      // unguaranteed deposit decreases the total value until the next report
      // quarantine value hasnt kicked in before the next report
      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta],
        [lazyOracle.quarantineValue(stakingVault), 0n],
        [dashboard.accruedFee(), 0n],
        [dashboard.settledGrowth(), minActiveValidatorBalance],
      ]);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // total value is still reduced
      // quarantine value has kicked in
      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta],
        [lazyOracle.quarantineValue(stakingVault), minActiveValidatorBalance],
      ]);

      // wait out the quarantine period
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      expectedTotalValue += minActiveValidatorBalance;

      // total value is back to the original value
      // quarantine value is released
      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta],
        [lazyOracle.quarantineValue(stakingVault), 0n],
      ]);

      await addValidatorsToTree([unguaranteedValidator]);
      const { header, timestamp } = await commitAndProveValidators([unguaranteedValidator], 200);
      const witnesses = toWitnesses([unguaranteedValidator], header, timestamp);

      await expect(dashboard.connect(nodeOperatorManager).proveUnknownValidatorsToPDG(witnesses)).to.emit(
        predepositGuarantee,
        "ValidatorProven",
      );

      // validator is proven
      await mEqual([
        [
          predepositGuarantee.validatorStatus(unguaranteedValidator.container.pubkey).then((s) => s.stage),
          ValidatorStage.ACTIVATED,
        ],
      ]);

      const topUpAmount = ether("1");
      await predepositGuarantee
        .connect(nodeOperator)
        .topUpExistingValidators([{ pubkey: unguaranteedValidator.container.pubkey, amount: topUpAmount }]);

      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta],
      ]);
    });

    it("processes side-deposited validators", async () => {
      await dashboard.connect(vaultOwner).setPDGPolicy(PDGPolicy.ALLOW_PROVE);
      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.ALLOW_PROVE]]);

      const sideDepositedValidator = createValidators(1)[0];
      const sideDepositAmount = minActiveValidatorBalance;

      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);

      // Side deposit happens externally - validator just appears on the beacon chain
      // Add fee exemption to prevent this being counted as rewards
      const settledGrowthBefore = await dashboard.settledGrowth();
      await dashboard.connect(nodeOperatorManager).addFeeExemption(sideDepositAmount);
      await mEqual([[dashboard.settledGrowth(), settledGrowthBefore + sideDepositAmount]]);

      // First report - value will be quarantined because the increase exceeds maxRewardRatioBP
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + sideDepositAmount, // side deposit is reported
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // total value is still at old value (quarantined)
      // quarantine value has kicked in
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore],
        [currentInOutDelta(stakingVault), inOutDeltaBefore],
        [lazyOracle.quarantineValue(stakingVault), sideDepositAmount],
        [dashboard.settledGrowth(), settledGrowthBefore + sideDepositAmount],
      ]);

      // wait out the quarantine period
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + sideDepositAmount,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // total value is now increased
      // quarantine value is released
      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBefore + sideDepositAmount],
        [currentInOutDelta(stakingVault), inOutDeltaBefore],
        [lazyOracle.quarantineValue(stakingVault), 0n],
      ]);

      await addValidatorsToTree([sideDepositedValidator]);
      const { header, timestamp } = await commitAndProveValidators([sideDepositedValidator], 300);
      const witnesses = toWitnesses([sideDepositedValidator], header, timestamp);

      await expect(dashboard.connect(nodeOperatorManager).proveUnknownValidatorsToPDG(witnesses)).to.emit(
        predepositGuarantee,
        "ValidatorProven",
      );

      // validator is proven
      await mEqual([
        [
          predepositGuarantee.validatorStatus(sideDepositedValidator.container.pubkey).then((s) => s.stage),
          ValidatorStage.ACTIVATED,
        ],
      ]);

      const totalValueBeforeTopUp = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBeforeTopUp = await currentInOutDelta(stakingVault);
      const topUpAmount = ether("1");

      await predepositGuarantee
        .connect(nodeOperator)
        .topUpExistingValidators([{ pubkey: sideDepositedValidator.container.pubkey, amount: topUpAmount }]);

      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBeforeTopUp],
        [currentInOutDelta(stakingVault), inOutDeltaBeforeTopUp],
      ]);
    });

    it("processes side deposit on same validator during unguaranteed deposit quarantine", async () => {
      await dashboard.connect(vaultOwner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);
      await mEqual([[dashboard.pdgPolicy(), PDGPolicy.ALLOW_DEPOSIT_AND_PROVE]]);

      const validator = createValidators(1)[0];
      const unguaranteedDeposit = generateDepositStruct(validator.container, minActiveValidatorBalance);
      const sideDepositAmount = ether("16"); // additional ETH deposited externally

      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBefore = await currentInOutDelta(stakingVault);

      // Step 1: Make unguaranteed deposit - this decreases total value immediately
      await dashboard.connect(nodeOperatorManager).unguaranteedDepositToBeaconChain([unguaranteedDeposit]);

      const expectedInOutDelta = inOutDeltaBefore - minActiveValidatorBalance;
      let expectedTotalValue = totalValueBefore - minActiveValidatorBalance;

      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta],
        [lazyOracle.quarantineValue(stakingVault), 0n], // quarantine not kicked in yet
      ]);

      // Step 2: First report - starts quarantine for the unguaranteed deposit
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore, // report original value (validator appeared on beacon chain)
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta],
        [lazyOracle.quarantineValue(stakingVault), minActiveValidatorBalance],
      ]);

      // Step 3: Side deposit happens during quarantine - add fee exemption
      const settledGrowthBefore = await dashboard.settledGrowth();
      await dashboard.connect(nodeOperatorManager).addFeeExemption(sideDepositAmount);
      await mEqual([[dashboard.settledGrowth(), settledGrowthBefore + sideDepositAmount]]);

      // Step 4: Report with side deposit included - this adds to quarantine
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + sideDepositAmount, // now includes side deposit
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Both unguaranteed and side deposit are in quarantine
      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta],
        [lazyOracle.quarantineValue(stakingVault), minActiveValidatorBalance + sideDepositAmount],
      ]);

      // Step 5: Wait out quarantine period for the first (unguaranteed) deposit
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod);

      // Step 6: Report to release unguaranteed deposit quarantine
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + sideDepositAmount,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Unguaranteed deposit quarantine released, but side deposit quarantine still pending
      // (side deposit was added later, so its quarantine timer started later)
      expectedTotalValue = totalValueBefore; // only unguaranteed deposit released

      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta],
        [lazyOracle.quarantineValue(stakingVault), sideDepositAmount], // side deposit still in quarantine
      ]);

      // Step 7: Wait out quarantine period for the side deposit
      await advanceChainTime(quarantinePeriod);

      // Step 8: Report to release side deposit quarantine
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValueBefore + sideDepositAmount,
        waitForNextRefSlot: true,
        updateReportData: true,
      });

      // Both quarantines released - total value now includes both deposits
      expectedTotalValue = totalValueBefore + sideDepositAmount;

      await mEqual([
        [vaultHub.totalValue(stakingVault), expectedTotalValue],
        [currentInOutDelta(stakingVault), expectedInOutDelta], // inOutDelta unchanged from unguaranteed deposit
        [lazyOracle.quarantineValue(stakingVault), 0n],
      ]);

      // Step 9: Prove the validator
      await addValidatorsToTree([validator]);
      const { header, timestamp } = await commitAndProveValidators([validator], 400);
      const witnesses = toWitnesses([validator], header, timestamp);

      await expect(dashboard.connect(nodeOperatorManager).proveUnknownValidatorsToPDG(witnesses)).to.emit(
        predepositGuarantee,
        "ValidatorProven",
      );

      await mEqual([
        [
          predepositGuarantee.validatorStatus(validator.container.pubkey).then((s) => s.stage),
          ValidatorStage.ACTIVATED,
        ],
      ]);

      // Step 10: Top up the validator
      const totalValueBeforeTopUp = await vaultHub.totalValue(stakingVault);
      const inOutDeltaBeforeTopUp = await currentInOutDelta(stakingVault);
      const topUpAmount = ether("1");

      await predepositGuarantee
        .connect(nodeOperator)
        .topUpExistingValidators([{ pubkey: validator.container.pubkey, amount: topUpAmount }]);

      await mEqual([
        [vaultHub.totalValue(stakingVault), totalValueBeforeTopUp],
        [currentInOutDelta(stakingVault), inOutDeltaBeforeTopUp],
      ]);
    });

    it("processes CL rewards", async () => {
      const accruedFeeBefore = await dashboard.accruedFee();
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const connection = await vaultHub.vaultConnection(stakingVault);
      const vaultRecord = await vaultHub.vaultRecord(stakingVault);

      // Simulate 3% annual growth based on elapsed time
      const { timeElapsed } = await getReportTimeElapsed(ctx);
      const VAULT_APR_BP = 4_00n; // 4% Vault APR (vault's own staking rewards)
      const vaultReward = (totalValueBefore * VAULT_APR_BP * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;
      const newTotalValue = totalValueBefore + vaultReward;

      // Calculate cumulative Lido fees based on fee structure:
      // Infrastructure fee = Total_value × Lido_Core_APR × infraFeeBP
      // Reservation fee = Mintable_stETH (shareLimit) × Lido_Core_APR × reservationFeeBP
      // Liquidity fee = Minted_stETH (liabilityShares) × Lido_Core_APR × liquidityFeeBP
      const LIDO_CORE_APR_BP = 3_00n; // 3% Lido Core APR (used for fee calculations)

      // Multiply first, then divide to avoid integer truncation
      // fee = value * APR_BP * feeBP * timeElapsed / (TOTAL_BP * TOTAL_BP * ONE_YEAR)
      const divisor = TOTAL_BASIS_POINTS * TOTAL_BASIS_POINTS * ONE_YEAR;

      // Infrastructure fee on total value
      const infraFee = (totalValueBefore * LIDO_CORE_APR_BP * BigInt(connection.infraFeeBP) * timeElapsed) / divisor;

      // Reservation fee on mintable stETH (share limit in ETH)
      const mintableStETH = await lido.getPooledEthByShares(connection.shareLimit);
      const reservationFee =
        (mintableStETH * LIDO_CORE_APR_BP * BigInt(connection.reservationFeeBP) * timeElapsed) / divisor;

      // Liquidity fee on minted stETH (liability shares in ETH)
      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      const mintedStETH = await lido.getPooledEthByShares(liabilityShares);
      const liquidityFee = (mintedStETH * LIDO_CORE_APR_BP * BigInt(connection.liquidityFeeBP) * timeElapsed) / divisor;

      const lidoFeesIncrement = infraFee + reservationFee + liquidityFee;
      const newCumulativeLidoFees = vaultRecord.cumulativeLidoFees + lidoFeesIncrement;

      expect(newCumulativeLidoFees).to.be.gt(vaultRecord.cumulativeLidoFees);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: newTotalValue,
        cumulativeLidoFees: newCumulativeLidoFees,
        waitForNextRefSlot: true,
      });

      // Check that node operator accrued fee increased
      const accruedFeeAfter = await dashboard.accruedFee();
      expect(accruedFeeAfter).to.be.gt(accruedFeeBefore);

      // Verify the fee is based on growth, times node operator fee rate
      const nodeOperatorFeeRate = await dashboard.feeRate();
      const expectedFeeIncrease = (vaultReward * BigInt(nodeOperatorFeeRate)) / TOTAL_BASIS_POINTS;

      // Allow small rounding tolerance
      expect(accruedFeeAfter - accruedFeeBefore).to.be.equal(expectedFeeIncrease);
    });

    it("pauses and resumes beacon chain deposits", async () => {
      // Pause beacon chain deposits
      await dashboard.connect(vaultOwner).pauseBeaconChainDeposits();
      const connectionAfterPause = await vaultHub.vaultConnection(stakingVault);
      await mEqual([
        [connectionAfterPause.beaconChainDepositsPauseIntent, true],
        [stakingVault.beaconChainDepositsPaused(), true],
      ]);

      // Verify PDG top-up deposits are blocked while paused
      const validatorPubkey = guaranteedValidators[0].container.pubkey;
      await expect(
        predepositGuarantee
          .connect(nodeOperator)
          .topUpExistingValidators([{ pubkey: validatorPubkey, amount: ether("1") }]),
      ).to.be.revertedWithCustomError(stakingVault, "BeaconChainDepositsOnPause");

      // Resume beacon chain deposits
      await dashboard.connect(vaultOwner).resumeBeaconChainDeposits();
      const connectionAfterResume = await vaultHub.vaultConnection(stakingVault);
      await mEqual([
        [connectionAfterResume.beaconChainDepositsPauseIntent, false],
        [stakingVault.beaconChainDepositsPaused(), false],
      ]);
    });

    it("changes fee recipient", async () => {
      const newFeeRecipient = certainAddress("new fee recipient");
      await dashboard.connect(nodeOperatorManager).setFeeRecipient(newFeeRecipient);
      await mEqual([[dashboard.feeRecipient(), newFeeRecipient]]);
    });

    it("disburses node operator fee", async () => {
      // Get current state
      const accruedFeeBefore = await dashboard.accruedFee();
      const settledGrowthBefore = await dashboard.settledGrowth();
      const totalValueBefore = await vaultHub.totalValue(stakingVault);
      const latestReportBefore = await dashboard.latestReport();
      const growthBefore = BigInt(latestReportBefore.totalValue) - latestReportBefore.inOutDelta;

      // Simulate rewards by reporting increased totalValue
      const rewardAmount = ether("5"); // 5 ETH reward
      const newTotalValue = totalValueBefore + rewardAmount;

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: newTotalValue,
        waitForNextRefSlot: true,
      });

      // Verify growth increased
      const latestReportAfter = await dashboard.latestReport();
      const growthAfter = BigInt(latestReportAfter.totalValue) - latestReportAfter.inOutDelta;
      expect(growthAfter).to.be.gt(growthBefore);

      // Calculate expected fee: unsettledGrowth × feeRate / 10000
      const feeRate = await dashboard.feeRate();
      const unsettledGrowth = growthAfter - settledGrowthBefore;
      const expectedFee = unsettledGrowth > 0n ? (unsettledGrowth * BigInt(feeRate)) / TOTAL_BASIS_POINTS : 0n;

      const accruedFeeAfter = await dashboard.accruedFee();
      expect(accruedFeeAfter).to.equal(expectedFee);
      expect(accruedFeeAfter).to.be.gt(accruedFeeBefore);

      // Disburse fee and verify fee recipient received it
      const feeRecipient = await dashboard.feeRecipient();
      const recipientBalanceBefore = await ethers.provider.getBalance(feeRecipient);

      await expect(dashboard.connect(nodeOperator).disburseFee()).to.emit(dashboard, "FeeDisbursed");

      const recipientBalanceAfter = await ethers.provider.getBalance(feeRecipient);
      expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + accruedFeeAfter);
      expect(await dashboard.accruedFee()).to.equal(0n);
    });

    it("changes fee rate with dual confirmation", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const currentFeeRate = await dashboard.feeRate();
      const newFeeRate = currentFeeRate + 1_00n; // Increase by 1%

      // First confirmation from node operator manager - returns false (pending)
      expect(await dashboard.connect(nodeOperatorManager).setFeeRate.staticCall(newFeeRate)).to.equal(false);
      await dashboard.connect(nodeOperatorManager).setFeeRate(newFeeRate);
      expect(await dashboard.feeRate()).to.equal(currentFeeRate); // Not changed yet

      // Second confirmation from vault owner - returns true (applied)
      expect(await dashboard.connect(vaultOwner).setFeeRate.staticCall(newFeeRate)).to.equal(true);
      await expect(dashboard.connect(vaultOwner).setFeeRate(newFeeRate)).to.emit(dashboard, "FeeRateSet");
      expect(await dashboard.feeRate()).to.equal(newFeeRate);
    });

    it("reverts fee change if the correction timestamp is after the latest report timestamp", async () => {
      const snapshotBefore = await Snapshot.take();

      // Ensure we have a fresh report first
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      // Make a correction which updates latestCorrectionTimestamp to current block timestamp
      const currentSettledGrowth = await dashboard.settledGrowth();
      const newSettledGrowth = currentSettledGrowth + ether("1");
      await dashboard.connect(nodeOperatorManager).correctSettledGrowth(newSettledGrowth, currentSettledGrowth);
      await dashboard.connect(vaultOwner).correctSettledGrowth(newSettledGrowth, currentSettledGrowth);

      // Now latestCorrectionTimestamp > latestReportTimestamp
      // Trying to change fee rate should revert
      const newFeeRate = (await dashboard.feeRate()) + 1_00n;
      await expect(dashboard.connect(nodeOperatorManager).setFeeRate(newFeeRate)).to.be.revertedWithCustomError(
        dashboard,
        "CorrectionAfterReport",
      );

      // After a new report, fee change should work
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });
      await dashboard.connect(nodeOperatorManager).setFeeRate(newFeeRate);
      await dashboard.connect(vaultOwner).setFeeRate(newFeeRate);
      expect(await dashboard.feeRate()).to.equal(newFeeRate);

      await Snapshot.restore(snapshotBefore);
    });

    it("disburses abnormally high fee only by admin", async () => {
      // Abnormally high = fee > 1% of totalValue
      // To exceed threshold: (unsettledGrowth * feeRate / 10000) > totalValue / 100
      // So we need: unsettledGrowth > totalValue * 100 / feeRate
      const totalValue = await vaultHub.totalValue(stakingVault);
      const feeRate = await dashboard.feeRate();
      const requiredReward = (totalValue * 100n) / BigInt(feeRate) + ether("10");

      // Send a big chunk of ETH to the vault to simulate large rewards
      const vaultAddress = await stakingVault.getAddress();
      await setBalance(vaultAddress, (await ethers.provider.getBalance(vaultAddress)) + requiredReward);

      // Report the new totalValue with the large reward
      const newTotalValue = totalValue + requiredReward;
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: newTotalValue,
        waitForNextRefSlot: true,
      });

      // Verify fee is abnormally high (> 1% of totalValue)
      const accruedFee = await dashboard.accruedFee();
      const abnormallyHighThreshold = newTotalValue / 100n;
      expect(accruedFee).to.be.gt(abnormallyHighThreshold);

      // Regular disburseFee should revert
      await expect(dashboard.connect(nodeOperator).disburseFee()).to.be.revertedWithCustomError(
        dashboard,
        "AbnormallyHighFee",
      );

      // Admin can still disburse abnormally high fee
      await expect(dashboard.connect(vaultOwner).disburseAbnormallyHighFee()).to.emit(dashboard, "FeeDisbursed");
      expect(await dashboard.accruedFee()).to.equal(0n);
    });

    it("updates share limit and syncs tier", async () => {
      const snapshotBefore = await Snapshot.take();

      const newShareLimit = ether("600");
      await operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, newShareLimit);
      await expect(dashboard.connect(vaultOwner).updateShareLimit(newShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );
      await mEqual([[vaultHub.vaultConnection(stakingVault).then((c) => c.shareLimit), newShareLimit]]);

      const updatedTierParams: TierParamsStruct = {
        ...TIER_1_PARAMS,
        infraFeeBP: 4_00n,
        liquidityFeeBP: 3_00n,
      };

      await operatorGrid.connect(agent).alterTiers([TIER_1_ID], [updatedTierParams]);
      const tierAfterAlter = await operatorGrid.tier(Number(TIER_1_ID));
      await mEqual([
        [tierAfterAlter.infraFeeBP, updatedTierParams.infraFeeBP],
        [tierAfterAlter.liquidityFeeBP, updatedTierParams.liquidityFeeBP],
        [tierAfterAlter.forcedRebalanceThresholdBP, updatedTierParams.forcedRebalanceThresholdBP],
      ]);

      await operatorGrid.connect(nodeOperator).syncTier(stakingVault);
      await expect(dashboard.connect(vaultOwner).syncTier()).to.emit(vaultHub, "VaultConnectionUpdated");

      const connection = await vaultHub.vaultConnection(stakingVault);
      await mEqual([
        [connection.infraFeeBP, updatedTierParams.infraFeeBP],
        [connection.liquidityFeeBP, updatedTierParams.liquidityFeeBP],
        [connection.reservationFeeBP, updatedTierParams.reservationFeeBP],
        [connection.reserveRatioBP, updatedTierParams.reserveRatioBP],
        [connection.forcedRebalanceThresholdBP, updatedTierParams.forcedRebalanceThresholdBP],
        [connection.shareLimit, newShareLimit],
      ]);

      await Snapshot.restore(snapshotBefore);
    });

    it("sets depositor in PDG", async () => {
      await predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(delegatedDepositor.address);
      await mEqual([[predepositGuarantee.nodeOperatorDepositor(nodeOperator), delegatedDepositor.address]]);
    });

    it("handles guarantor refund flow", async () => {
      // Top up node operator balance
      const balanceBefore = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
      await predepositGuarantee.connect(guarantor).topUpNodeOperatorBalance(nodeOperator, { value: ether("2") });
      const balanceAfterTopUp = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
      await mEqual([
        [balanceAfterTopUp.total, balanceBefore.total + ether("2")],
        [balanceAfterTopUp.locked, 0n],
      ]);

      // Change guarantor - this makes the old guarantor's funds claimable
      const newGuarantor = stranger;
      await predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(newGuarantor.address);
      await mEqual([
        [predepositGuarantee.nodeOperatorGuarantor(nodeOperator), newGuarantor.address],
        [predepositGuarantee.nodeOperatorBalance(nodeOperator).then((b) => b.total), 0n],
      ]);

      // Old guarantor claims refund
      const claimable = await predepositGuarantee.claimableRefund(guarantor.address);
      expect(claimable).to.be.gt(0n);

      const guarantorEthBefore = await ethers.provider.getBalance(guarantor);
      const tx = await predepositGuarantee.connect(guarantor).claimGuarantorRefund(guarantor);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasPrice * receipt!.cumulativeGasUsed;

      await mEqual([
        [ethers.provider.getBalance(guarantor), guarantorEthBefore - gasCost + claimable],
        [predepositGuarantee.claimableRefund(guarantor.address), 0n],
      ]);
    });

    it("connects multiple vaults under same operator group", async () => {
      const { vault: stakingVault2, dashboard: dashboard2 } = await createVaultProxyWithoutConnectingToVaultHub(
        nodeOperator,
        stakingVaultFactory,
        vaultOwner,
        nodeOperator,
        nodeOperator,
        VAULT_NODE_OPERATOR_FEE,
        CONFIRM_EXPIRY,
      );

      const stakingVault2Address = await stakingVault2.getAddress();

      await operatorGrid.connect(nodeOperator).changeTier(stakingVault2Address, TIER_1_ID, ether("400"));
      await dashboard2
        .connect(vaultOwner)
        .connectAndAcceptTier(TIER_1_ID, ether("400"), { value: VAULT_CONNECTION_DEPOSIT });

      const tierInfo = await operatorGrid.vaultTierInfo(stakingVault2Address);
      await mEqual([
        [vaultHub.isVaultConnected(stakingVault2Address), true],
        [tierInfo.tierId, TIER_1_ID],
        [tierInfo.shareLimit, TIER_1_PARAMS.shareLimit],
      ]);

      const connectionVault2 = await vaultHub.vaultConnection(stakingVault2Address);
      await mEqual([[connectionVault2.shareLimit, ether("400")]]);

      // Verify group tracks liability from both vaults
      const groupAfter = await operatorGrid.group(nodeOperator);
      const liabilityFromVault1 = await vaultHub.liabilityShares(stakingVault);
      await mEqual([[groupAfter.liabilityShares, liabilityFromVault1]]);
    });

    it("ejects validators via triggerable withdrawals", async () => {
      if (!guaranteedValidators.length) {
        const fallbackValidator = generateValidator(withdrawalCredentials);
        guaranteedValidators = [{ ...fallbackValidator, index: 0, proof: [] }];
      }
      const pubkey = hexlify(guaranteedValidators[0].container.pubkey);
      const fee = await stakingVault.calculateValidatorWithdrawalFee(1n);

      await expect(stakingVault.connect(nodeOperator).ejectValidators(pubkey, nodeOperator, { value: fee })).to.emit(
        stakingVault,
        "ValidatorEjectionsTriggered",
      );
    });

    it("handles tier permutations across tiers", async () => {
      // First mint some shares to test that we can burn them before tier change
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });
      const mintingCapacity = await dashboard.totalMintingCapacityShares();
      const sharesToMint = mintingCapacity / 2n;
      await dashboard.connect(vaultOwner).mintShares(vaultOwner.address, sharesToMint);
      await mEqual([[vaultHub.liabilityShares(stakingVault), sharesToMint]]);

      // Burn all minted shares before changing tiers
      // TIER_2 has higher reserve ratio (15%) vs TIER_1 (10%), so the vault needs
      // more value per share. Burning shares ensures we can test tier changes.
      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      if (liabilityShares > 0n) {
        // Dashboard.burnShares calls STETH.transferSharesFrom(msg.sender, VAULT_HUB, amount)
        // The allowance is in token amounts (ETH equivalent), not shares
        await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(liabilityShares));
        await dashboard.connect(vaultOwner).burnShares(liabilityShares);
      }
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);

      const tierAltShareLimit = ether("800");

      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, TIER_2_ID, tierAltShareLimit);
      const canApplyAlt = await dashboard.connect(vaultOwner).changeTier.staticCall(TIER_2_ID, tierAltShareLimit);
      expect(canApplyAlt).to.equal(true);
      await expect(dashboard.connect(vaultOwner).changeTier(TIER_2_ID, tierAltShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const [, tierAfterId, tierAfterShareLimit] = await operatorGrid.vaultTierInfo(stakingVault);
      const connectionAfterAlt = await vaultHub.vaultConnection(stakingVault);
      await mEqual([
        [tierAfterId, TIER_2_ID],
        [tierAfterShareLimit, TIER_2_PARAMS.shareLimit],
        [connectionAfterAlt.shareLimit, tierAltShareLimit],
      ]);

      const tierPrimaryShareLimit = ether("900");
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, TIER_1_ID, tierPrimaryShareLimit);
      const canApplyPrimary = await dashboard
        .connect(vaultOwner)
        .changeTier.staticCall(TIER_1_ID, tierPrimaryShareLimit);
      expect(canApplyPrimary).to.equal(true);
      await expect(dashboard.connect(vaultOwner).changeTier(TIER_1_ID, tierPrimaryShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const [, tierFinalId, tierFinalShareLimit] = await operatorGrid.vaultTierInfo(stakingVault);
      const connectionAfterPrimary = await vaultHub.vaultConnection(stakingVault);
      await mEqual([
        [tierFinalId, TIER_1_ID],
        [tierFinalShareLimit, TIER_1_PARAMS.shareLimit],
        [connectionAfterPrimary.shareLimit, tierPrimaryShareLimit],
      ]);
    });

    it("increases share limit when reaching capacity", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      // Start fresh - burn any existing shares
      const existingShares = await vaultHub.liabilityShares(stakingVault);
      if (existingShares > 0n) {
        await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(existingShares));
        await dashboard.connect(vaultOwner).burnShares(existingShares);
      }
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);

      // Set a restrictive share limit to make it the binding constraint
      const restrictiveLimit = ether("5");
      await operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, restrictiveLimit);
      await dashboard.connect(vaultOwner).updateShareLimit(restrictiveLimit);

      // Verify the share limit is set
      const connection = await vaultHub.vaultConnection(stakingVault);
      expect(connection.shareLimit).to.equal(restrictiveLimit);

      // Mint up to the remaining capacity (should be limited by share limit)
      const remainingBefore = await dashboard.remainingMintingCapacityShares(0);
      expect(remainingBefore).to.be.lte(restrictiveLimit);
      await dashboard.connect(vaultOwner).mintShares(vaultOwner.address, remainingBefore);

      const liabilityAfterMint = await vaultHub.liabilityShares(stakingVault);
      expect(liabilityAfterMint).to.equal(remainingBefore);

      // Verify remaining capacity is exhausted
      const remainingAfterMint = await dashboard.remainingMintingCapacityShares(0);
      expect(remainingAfterMint).to.equal(0n);

      // Increase share limit to unlock more capacity
      const higherLimit = ether("15");
      await operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, higherLimit);
      await dashboard.connect(vaultOwner).updateShareLimit(higherLimit);

      // Now have additional remaining capacity
      const newRemaining = await dashboard.remainingMintingCapacityShares(0);
      expect(newRemaining).to.be.gt(0n);

      // Mint additional shares
      await dashboard.connect(vaultOwner).mintShares(vaultOwner.address, newRemaining);
      expect(await vaultHub.liabilityShares(stakingVault)).to.be.gt(liabilityAfterMint);

      // Clean up for subsequent tests
      const finalShares = await vaultHub.liabilityShares(stakingVault);
      await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(finalShares));
      await dashboard.connect(vaultOwner).burnShares(finalShares);
      // Restore a reasonable share limit
      await operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, ether("500"));
      await dashboard.connect(vaultOwner).updateShareLimit(ether("500"));
    });

    it("socializes bad debt between vaults", async () => {
      // Mint shares to create liability - needed for bad debt to exist
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });
      const mintingCapacity = await dashboard.totalMintingCapacityShares();
      const sharesToMint = mintingCapacity / 2n;
      expect(sharesToMint).to.be.gt(0n);
      await dashboard.connect(vaultOwner).mintShares(vaultOwner.address, sharesToMint);
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(sharesToMint);

      const { vault: acceptorVault, dashboard: acceptorDashboard } = await createVaultProxyWithoutConnectingToVaultHub(
        nodeOperator,
        stakingVaultFactory,
        vaultOwner,
        nodeOperator,
        nodeOperator,
        VAULT_NODE_OPERATOR_FEE,
        CONFIRM_EXPIRY,
      );
      const acceptorAddress = await acceptorVault.getAddress();

      await operatorGrid.connect(nodeOperator).changeTier(acceptorAddress, TIER_1_ID, ether("600"));
      await acceptorDashboard.connect(vaultOwner).connectAndAcceptTier(TIER_1_ID, ether("600"), {
        value: VAULT_CONNECTION_DEPOSIT,
      });
      const [, acceptorTierId, acceptorTierShareLimit] = await operatorGrid.vaultTierInfo(acceptorVault);
      const acceptorConnection = await vaultHub.vaultConnection(acceptorVault);
      await mEqual([
        [vaultHub.isVaultConnected(acceptorVault), true],
        [acceptorTierId, TIER_1_ID],
        [acceptorTierShareLimit, TIER_1_PARAMS.shareLimit],
        [acceptorConnection.shareLimit, ether("600")],
      ]);

      await acceptorDashboard.connect(vaultOwner).fund({ value: ether("200") });
      await mEqual([[acceptorVault.availableBalance(), ether("200") + VAULT_CONNECTION_DEPOSIT]]);

      const badDebtValue = ether("1");
      const acceptorCurrentValue = await vaultHub.totalValue(acceptorVault);

      await reportVaultsDataWithProof(ctx, [stakingVault, acceptorVault], {
        totalValue: [badDebtValue, acceptorCurrentValue],
        waitForNextRefSlot: true,
      });

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));
      expect(badDebtShares).to.be.gt(0n);

      const badDebtMaster = await ctx.getSigner("agent");
      await vaultHub.connect(badDebtMaster).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), badDebtMaster.address);
      expect(await vaultHub.hasRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), badDebtMaster.address)).to.equal(true);

      await expect(
        vaultHub.connect(badDebtMaster).socializeBadDebt(stakingVault, acceptorVault, badDebtShares),
      ).to.emit(vaultHub, "BadDebtSocialized");

      const remainingBadDebt =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));
      expect(remainingBadDebt).to.be.lt(badDebtShares);
      expect(await acceptorDashboard.liabilityShares()).to.be.gte(badDebtShares);
    });

    it("disconnects and reconnects after correcting growth", async () => {
      const snapshotOperational = await Snapshot.take();

      const shares = await vaultHub.liabilityShares(stakingVault);
      if (shares > 0n) {
        await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(shares));
        await dashboard.connect(vaultOwner).burnShares(shares);
      }
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);

      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });
      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.equal(true);

      await expect(reportVaultDataWithProof(ctx, stakingVault))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);

      const feeLeftover = await dashboard.feeLeftover();
      if (feeLeftover > 0n) {
        await dashboard.connect(nodeOperatorManager).recoverFeeLeftover();
        expect(await dashboard.feeLeftover()).to.equal(0n);
      }

      const currentSettledGrowth = await dashboard.settledGrowth();
      await dashboard.connect(nodeOperatorManager).correctSettledGrowth(0n, currentSettledGrowth);
      await dashboard.connect(vaultOwner).correctSettledGrowth(0n, currentSettledGrowth);
      expect(await dashboard.settledGrowth()).to.equal(0n);

      await dashboard.connect(vaultOwner).reconnectToVaultHub();
      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(true);

      await Snapshot.restore(snapshotOperational);
    });

    it("ossifies after ownership transfer", async () => {
      const shares = await vaultHub.liabilityShares(stakingVault);
      if (shares > 0n) {
        await lido.connect(vaultOwner).approve(dashboard, await lido.getPooledEthByShares(shares));
        await dashboard.connect(vaultOwner).burnShares(shares);
      }

      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });
      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);

      await dashboard.connect(vaultOwner).abandonDashboard(stranger.address);
      expect(await stakingVault.pendingOwner()).to.equal(stranger.address);

      await stakingVault.connect(stranger).acceptOwnership();
      expect(await stakingVault.owner()).to.equal(stranger.address);

      await stakingVault.connect(stranger).ossify();

      const proxy = await ethers.getContractAt("PinnedBeaconProxy", stakingVault);
      expect(await proxy.isOssified()).to.equal(true);
    });

    async function currentInOutDelta(vault: StakingVault): Promise<bigint> {
      const record = await vaultHub.vaultRecord(await vault.getAddress());
      const [cache0, cache1] = record.inOutDelta;
      return cache0.refSlot >= cache1.refSlot ? cache0.value : cache1.value;
    }
  }),
);
