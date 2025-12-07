import { expect } from "chai";
import { ContractTransactionReceipt, hexlify } from "ethers";
import { ethers } from "hardhat";

import { SecretKey } from "@chainsafe/blst";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard,
  Lido,
  OperatorGrid,
  PredepositGuarantee,
  SSZBLSHelpers,
  StakingVault,
  ValidatorConsolidationRequests,
  VaultFactory,
  VaultHub,
} from "typechain-types";

import {
  days,
  ether,
  generateDepositStruct,
  generatePredeposit,
  generateValidator,
  LocalMerkleTree,
  PDGPolicy,
  prepareLocalMerkleTree,
  updateBalance,
} from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";
import {
  createVaultProxyWithoutConnectingToVaultHub,
  getProtocolContext,
  getReportTimeElapsed,
  OracleReportParams,
  report,
  reportVaultDataWithProof,
  reportVaultsDataWithProof,
  setupLidoForVaults,
  VAULT_CONNECTION_DEPOSIT,
} from "lib/protocol";

import { generateConsolidationRequestPayload } from "test/0.8.25/vaults/consolidation/consolidationHelper";
import { resetState, Snapshot } from "test/suite";
import { ONE_DAY } from "test/suite/constants";

const ONE_YEAR = 365n * ONE_DAY;
const SIMULATED_PROTOCOL_APR = 3_00n;
const PROTOCOL_FEE = 10_00n;

const VAULT_NODE_OPERATOR_FEE = 5_00n;
const CONFIRM_EXPIRY = days(7n);

const SHARE_LIMIT_TIER1 = ether("1000");
const SHARE_LIMIT_TIER2 = ether("1500");
const RESERVE_RATIO_TIER1_BP = 10_00n;
const RESERVE_RATIO_TIER2_BP = 15_00n;
const FORCED_REBALANCE_THRESHOLD_TIER1_BP = 9_75n; // 0.25% below tier1 RR
const FORCED_REBALANCE_THRESHOLD_TIER2_BP = 14_75n; // 0.25% below tier2 RR
const INFRA_FEE_BP = 1_00n;
const LIQUIDITY_FEE_BP = 6_00n;
const RESERVATION_FEE_BP = 50n;

type ValidatorInfo = {
  container: SSZBLSHelpers.ValidatorStruct;
  blsPrivateKey: SecretKey;
  index: number;
  proof: string[];
};

resetState(
  describe("Scenario: Node Operator Happy Path", () => {
    let ctx: Awaited<ReturnType<typeof getProtocolContext>>;
    let owner: HardhatEthersSigner;
    let nodeOperator: HardhatEthersSigner;
    let stranger: HardhatEthersSigner;
    let guarantor: HardhatEthersSigner;
    let delegatedDepositor: HardhatEthersSigner;
    let agent: HardhatEthersSigner;

    let vaultHub: VaultHub;
    let operatorGrid: OperatorGrid;
    let predepositGuarantee: PredepositGuarantee;
    let stakingVaultFactory: VaultFactory;
    let lido: Lido;
    let validatorConsolidationRequests: ValidatorConsolidationRequests;

    let stakingVault: StakingVault;
    let dashboard: Dashboard;

    let tier1Id: bigint;
    let tier2Id: bigint;

    let withdrawalCredentials: string;
    let depositDomain: string;
    let mockCLtree: LocalMerkleTree;
    let slot: bigint;
    let childBlockTimestamp: number;
    let beaconBlockHeader: SSZBLSHelpers.BeaconBlockHeaderStruct;

    let guaranteedValidators: ValidatorInfo[] = [];
    let unguaranteedValidators: ValidatorInfo[] = [];
    let sideDepositedValidators: ValidatorInfo[] = [];
    let consolidatorValidators: ValidatorInfo[] = [];

    let stakingVaultCLBalance = 0n;
    let activationDepositAmount: bigint;
    let guaranteedDepositAmounts: bigint[];
    let unguaranteedDepositAmounts: bigint[];
    let sideDepositedDepositAmounts: bigint[];
    let consolidatorDepositAmounts: bigint[];

    const fundAmount = ether("150");

    let snapshotPostMint: string;

    before(async () => {
      ctx = await getProtocolContext();
      [, owner, nodeOperator, stranger, guarantor, delegatedDepositor] = await ethers.getSigners();
      ({ vaultHub, operatorGrid, predepositGuarantee, stakingVaultFactory, lido, validatorConsolidationRequests } =
        ctx.contracts);
      agent = await ctx.getSigner("agent");

      await setupLidoForVaults(ctx);
      await setBalance(nodeOperator.address, ether("100"));

      activationDepositAmount = await predepositGuarantee.ACTIVATION_DEPOSIT_AMOUNT();
      guaranteedDepositAmounts = [activationDepositAmount, activationDepositAmount];
      unguaranteedDepositAmounts = [ether("1"), activationDepositAmount];
      sideDepositedDepositAmounts = [ether("24")];
      consolidatorDepositAmounts = [activationDepositAmount];
    });

    it("creates vault", async () => {
      const vaultCreationResult = await createVaultProxyWithoutConnectingToVaultHub(
        nodeOperator,
        stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
        VAULT_NODE_OPERATOR_FEE,
        CONFIRM_EXPIRY,
      );

      stakingVault = vaultCreationResult.vault;
      dashboard = vaultCreationResult.dashboard;

      expect(await stakingVault.nodeOperator()).to.equal(nodeOperator);
      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);
    });

    it("registers operator group and tiers", async () => {
      expect(stakingVault).to.not.equal(undefined);

      await operatorGrid.connect(agent).registerGroup(nodeOperator, SHARE_LIMIT_TIER2);
      const registeredGroup = await operatorGrid.group(nodeOperator);
      expect(registeredGroup.operator).to.equal(nodeOperator);
      expect(registeredGroup.shareLimit).to.equal(SHARE_LIMIT_TIER2);
      expect(registeredGroup.tierIds.length).to.equal(0);

      await operatorGrid.connect(agent).registerTiers(nodeOperator, [
        {
          shareLimit: SHARE_LIMIT_TIER1,
          reserveRatioBP: RESERVE_RATIO_TIER1_BP,
          forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_TIER1_BP,
          infraFeeBP: INFRA_FEE_BP,
          liquidityFeeBP: LIQUIDITY_FEE_BP,
          reservationFeeBP: RESERVATION_FEE_BP,
        },
        {
          shareLimit: SHARE_LIMIT_TIER2,
          reserveRatioBP: RESERVE_RATIO_TIER2_BP,
          forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_TIER2_BP,
          infraFeeBP: INFRA_FEE_BP,
          liquidityFeeBP: LIQUIDITY_FEE_BP,
          reservationFeeBP: RESERVATION_FEE_BP,
        },
      ]);

      const group = await operatorGrid.group(nodeOperator);
      expect(group.tierIds.length).to.equal(2);
      expect(group.shareLimit).to.equal(SHARE_LIMIT_TIER2);

      const tier0 = await operatorGrid.tier(group.tierIds[0]);
      expect(tier0.shareLimit).to.equal(SHARE_LIMIT_TIER1);
      expect(tier0.reserveRatioBP).to.equal(RESERVE_RATIO_TIER1_BP);
      expect(tier0.forcedRebalanceThresholdBP).to.equal(FORCED_REBALANCE_THRESHOLD_TIER1_BP);

      const tier1 = await operatorGrid.tier(group.tierIds[1]);
      expect(tier1.shareLimit).to.equal(SHARE_LIMIT_TIER2);
      expect(tier1.reserveRatioBP).to.equal(RESERVE_RATIO_TIER2_BP);
      expect(tier1.forcedRebalanceThresholdBP).to.equal(FORCED_REBALANCE_THRESHOLD_TIER2_BP);

      tier1Id = group.tierIds[0];
      tier2Id = group.tierIds[1];
    });

    it("pre-approves tier and connects vault", async () => {
      const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();

      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, tier1Id, SHARE_LIMIT_TIER1);
      const [, tierBeforeConnect] = await operatorGrid.vaultTierInfo(stakingVault);
      expect(tierBeforeConnect).to.equal(defaultTierId);

      await dashboard
        .connect(owner)
        .connectAndAcceptTier(tier1Id, SHARE_LIMIT_TIER1, { value: VAULT_CONNECTION_DEPOSIT });

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(true);
      const tierInfoAfterConnect = await operatorGrid.vaultTierInfo(stakingVault);

      expect(tierInfoAfterConnect.nodeOperator).to.equal(nodeOperator);
      expect(tierInfoAfterConnect.tierId).to.equal(tier1Id);
      expect(tierInfoAfterConnect.shareLimit).to.equal(SHARE_LIMIT_TIER1);
      expect(tierInfoAfterConnect.reserveRatioBP).to.equal(RESERVE_RATIO_TIER1_BP);
      expect(tierInfoAfterConnect.forcedRebalanceThresholdBP).to.equal(FORCED_REBALANCE_THRESHOLD_TIER1_BP);
      expect(tierInfoAfterConnect.infraFeeBP).to.equal(INFRA_FEE_BP);
      expect(tierInfoAfterConnect.liquidityFeeBP).to.equal(LIQUIDITY_FEE_BP);
      expect(tierInfoAfterConnect.reservationFeeBP).to.equal(RESERVATION_FEE_BP);
      const connectionAfterConnect = await vaultHub.vaultConnection(stakingVault);
      expect(connectionAfterConnect.shareLimit).to.equal(SHARE_LIMIT_TIER1);
    });

    it("funds vault and predeposits guaranteed validators", async () => {
      await dashboard.connect(owner).fund({ value: fundAmount });
      expect(await stakingVault.availableBalance()).to.equal(fundAmount + VAULT_CONNECTION_DEPOSIT);

      await predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(guarantor);
      expect(await predepositGuarantee.nodeOperatorGuarantor(nodeOperator)).to.equal(guarantor);

      const firstTopUpAmount =
        BigInt(guaranteedDepositAmounts.length) * (await predepositGuarantee.PREDEPOSIT_AMOUNT());
      const pdgBalanceBeforeTopUp = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
      expect(pdgBalanceBeforeTopUp.total).to.equal(0n);
      expect(pdgBalanceBeforeTopUp.locked).to.equal(0n);

      await predepositGuarantee.connect(guarantor).topUpNodeOperatorBalance(nodeOperator, {
        value: firstTopUpAmount,
      });
      const pdgBalanceAfterTopUp = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
      expect(pdgBalanceAfterTopUp.total).to.equal(firstTopUpAmount);
      expect(pdgBalanceAfterTopUp.locked).to.equal(0n);

      withdrawalCredentials = await stakingVault.withdrawalCredentials();
      depositDomain = await predepositGuarantee.DEPOSIT_DOMAIN();

      guaranteedValidators = [];
      for (let i = 0; i < guaranteedDepositAmounts.length; i++) {
        guaranteedValidators.push({ ...generateValidator(withdrawalCredentials), index: 0, proof: [] });
      }

      const predeposits = await Promise.all(
        guaranteedValidators.map((validator) => generatePredeposit(validator, { depositDomain })),
      );

      await predepositGuarantee.connect(nodeOperator).predeposit(
        stakingVault,
        predeposits.map((p) => p.deposit),
        predeposits.map((p) => p.depositY),
      );

      expect(await predepositGuarantee.pendingActivations(stakingVault)).to.equal(
        BigInt(guaranteedDepositAmounts.length),
      );

      slot = await predepositGuarantee.PIVOT_SLOT();
      mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_CURR());

      for (const validator of guaranteedValidators) {
        validator.index = (await mockCLtree.addValidator(validator.container)).validatorIndex;
      }

      ({ childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(Number(slot) + 100));

      for (const validator of guaranteedValidators) {
        validator.proof = await mockCLtree.buildProof(validator.index, beaconBlockHeader);
      }

      const witnesses = guaranteedValidators.map((validator) => ({
        proof: validator.proof,
        pubkey: hexlify(validator.container.pubkey),
        validatorIndex: validator.index,
        childBlockTimestamp,
        slot: beaconBlockHeader.slot,
        proposerIndex: beaconBlockHeader.proposerIndex,
      }));

      await predepositGuarantee.connect(nodeOperator).proveWCActivateAndTopUpValidators(
        witnesses,
        guaranteedValidators.map(() => 0n),
      );

      stakingVaultCLBalance += guaranteedDepositAmounts.reduce((acc, amt) => acc + amt, 0n);

      expect(await predepositGuarantee.pendingActivations(stakingVault)).to.equal(0n);
      expect(await stakingVault.stagedBalance()).to.equal(0n);
    });

    it("processes unguaranteed validators", async () => {
      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);
      expect(await dashboard.pdgPolicy()).to.equal(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);

      unguaranteedValidators = [];
      for (let i = 0; i < unguaranteedDepositAmounts.length; i++) {
        unguaranteedValidators.push({ ...generateValidator(withdrawalCredentials), index: 0, proof: [] });
      }

      const unguaranteedDeposits = unguaranteedValidators.map((v, i) =>
        generateDepositStruct(v.container, unguaranteedDepositAmounts[i]),
      );

      await expect(dashboard.connect(nodeOperator).unguaranteedDepositToBeaconChain(unguaranteedDeposits)).to.emit(
        dashboard,
        "UnguaranteedDeposits",
      );

      for (let index = 0; index < unguaranteedValidators.length; index++) {
        unguaranteedValidators[index].index = (
          await mockCLtree.addValidator(unguaranteedValidators[index].container)
        ).validatorIndex;
      }

      ({ childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(Number(slot) + 200));

      for (const validator of unguaranteedValidators) {
        validator.proof = await mockCLtree.buildProof(validator.index, beaconBlockHeader);
      }

      const unguaranteedWitnesses = unguaranteedValidators.map((validator) => ({
        proof: validator.proof,
        pubkey: hexlify(validator.container.pubkey),
        validatorIndex: validator.index,
        childBlockTimestamp,
        slot: beaconBlockHeader.slot,
        proposerIndex: beaconBlockHeader.proposerIndex,
      }));

      await expect(dashboard.connect(nodeOperator).proveUnknownValidatorsToPDG(unguaranteedWitnesses)).to.emit(
        predepositGuarantee,
        "ValidatorProven",
      );

      stakingVaultCLBalance += unguaranteedDepositAmounts.reduce((acc, amt) => acc + amt, 0n);
      // TODO: deposit to proven unguaranteed validator
    });

    it("processes side-deposited validators", async () => {
      sideDepositedValidators = [];
      for (let i = 0; i < sideDepositedDepositAmounts.length; i++) {
        sideDepositedValidators.push({ ...generateValidator(withdrawalCredentials), index: 0, proof: [] });
      }

      for (const validator of sideDepositedValidators) {
        validator.index = (await mockCLtree.addValidator(validator.container)).validatorIndex;
      }

      ({ childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(Number(slot) + 300));

      for (const validator of sideDepositedValidators) {
        validator.proof = await mockCLtree.buildProof(validator.index, beaconBlockHeader);
      }

      const sideDepositedWitnesses = sideDepositedValidators.map((validator) => ({
        proof: validator.proof,
        pubkey: hexlify(validator.container.pubkey),
        validatorIndex: validator.index,
        childBlockTimestamp,
        slot: beaconBlockHeader.slot,
        proposerIndex: beaconBlockHeader.proposerIndex,
      }));

      for (const validator of sideDepositedValidators) {
        const status = await predepositGuarantee.validatorStatus(validator.container.pubkey);
        expect(status[0]).to.equal(0n); // NONE status
      }

      await expect(dashboard.connect(nodeOperator).proveUnknownValidatorsToPDG(sideDepositedWitnesses)).to.emit(
        predepositGuarantee,
        "ValidatorProven",
      );

      for (const validator of sideDepositedValidators) {
        const status = await predepositGuarantee.validatorStatus(validator.container.pubkey);
        expect(status[0]).to.not.equal(0n); // No longer NONE
      }

      stakingVaultCLBalance += sideDepositedDepositAmounts.reduce((acc, amt) => acc + amt, 0n);
      // TODO: deposit to proven side-deposited validator
    });

    it("processes consolidator validators and consolidation requests", async () => {
      consolidatorValidators = [];
      for (let i = 0; i < consolidatorDepositAmounts.length; i++) {
        consolidatorValidators.push({ ...generateValidator(withdrawalCredentials), index: 0, proof: [] });
      }

      for (let index = 0; index < consolidatorValidators.length; index++) {
        consolidatorValidators[index].index = (
          await mockCLtree.addValidator(consolidatorValidators[index].container)
        ).validatorIndex;
      }

      ({ childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(Number(slot) + 400));

      for (let index = 0; index < consolidatorValidators.length; index++) {
        consolidatorValidators[index].proof = await mockCLtree.buildProof(
          consolidatorValidators[index].index,
          beaconBlockHeader,
        );
      }

      const consolidatorWitnesses = consolidatorValidators.map((validator) => ({
        proof: validator.proof,
        pubkey: hexlify(validator.container.pubkey),
        validatorIndex: validator.index,
        childBlockTimestamp,
        slot: beaconBlockHeader.slot,
        proposerIndex: beaconBlockHeader.proposerIndex,
      }));

      await expect(dashboard.connect(nodeOperator).proveUnknownValidatorsToPDG(consolidatorWitnesses)).to.emit(
        predepositGuarantee,
        "ValidatorProven",
      );

      stakingVaultCLBalance += consolidatorDepositAmounts.reduce((acc, amt) => acc + amt, 0n);

      await dashboard
        .connect(nodeOperator)
        .grantRole(await dashboard.NODE_OPERATOR_FEE_EXEMPT_ROLE(), validatorConsolidationRequests);
      expect(
        await dashboard.hasRole(await dashboard.NODE_OPERATOR_FEE_EXEMPT_ROLE(), validatorConsolidationRequests),
      ).to.equal(true);

      const { sourcePubkeys, targetPubkeys, adjustmentIncrease } = generateConsolidationRequestPayload(1);
      const { feeExemptionEncodedCall, consolidationRequestEncodedCalls } =
        await validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
          sourcePubkeys,
          targetPubkeys,
          await dashboard.getAddress(),
          adjustmentIncrease,
        );

      expect(consolidationRequestEncodedCalls.length).to.be.gt(0);
      expect(feeExemptionEncodedCall.length).to.be.gt(0);
    });

    it("mints shares and processes rewards", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const mintingCapacity = await dashboard.totalMintingCapacityShares();
      const sharesToMint = mintingCapacity / 2n;
      expect(mintingCapacity).to.be.gt(0n);

      await dashboard.connect(owner).mintShares(owner.address, sharesToMint);
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(sharesToMint);

      const { beaconBalance } = await lido.getBeaconStat();
      const { timeElapsed } = await getReportTimeElapsed(ctx);
      const gross = (SIMULATED_PROTOCOL_APR * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - PROTOCOL_FEE);
      const elapsedProtocolReward = (beaconBalance * gross * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;
      const elapsedVaultReward = (fundAmount * gross * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;

      const vaultAddress = await stakingVault.getAddress();
      const vaultBalance = (await ethers.provider.getBalance(vaultAddress)) + elapsedVaultReward;
      await updateBalance(vaultAddress, vaultBalance);

      await report(ctx, {
        clDiff: elapsedProtocolReward,
        excludeVaultsBalances: true,
      } as OracleReportParams);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: vaultBalance + stakingVaultCLBalance });

      expect(await dashboard.accruedFee()).to.be.gt(0n);
      const totalValueAfterReport = await dashboard.totalValue();
      expect(totalValueAfterReport).to.equal(await vaultHub.totalValue(stakingVault));
      expect(totalValueAfterReport).to.be.gt(vaultBalance);

      snapshotPostMint = await Snapshot.take();
    });

    it("rejects unguaranteed deposits under strict policy", async () => {
      await Snapshot.restore(snapshotPostMint);
      snapshotPostMint = await Snapshot.take();

      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.STRICT);

      const extraValidator = generateValidator(withdrawalCredentials);
      const extraDeposit = generateDepositStruct(extraValidator.container, activationDepositAmount);
      // TODO: grant role to an unguaranteed depositor
      await expect(dashboard.connect(nodeOperator).unguaranteedDepositToBeaconChain([extraDeposit])).to.be.reverted;

      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);
    });

    it("stages/unstages and handles pause/resume and withdrawals", async () => {
      await Snapshot.restore(snapshotPostMint);
      snapshotPostMint = await Snapshot.take();

      const stageAmount = ether("2");
      await expect(stakingVault.connect(nodeOperator).stage(stageAmount)).to.be.revertedWithCustomError(
        stakingVault,
        "SenderNotDepositor",
      );

      await dashboard.connect(owner).pauseBeaconChainDeposits();
      await dashboard.connect(owner).resumeBeaconChainDeposits();
      expect(await stakingVault.beaconChainDepositsPaused()).to.equal(false);

      const exitPubkey = guaranteedValidators[0].container.pubkey;
      await dashboard.connect(owner).requestValidatorExit(exitPubkey);

      const withdrawalFee = await stakingVault.calculateValidatorWithdrawalFee(1n);
      await dashboard
        .connect(owner)
        .triggerValidatorWithdrawals(exitPubkey, [], owner.address, { value: withdrawalFee });
    });

    it("blocks ossification while connected", async () => {
      await Snapshot.restore(snapshotPostMint);
      snapshotPostMint = await Snapshot.take();
      await expect(stakingVault.connect(owner).ossify()).to.be.reverted;
      await Snapshot.restore(snapshotPostMint);
      snapshotPostMint = await Snapshot.take();
    });

    it("disburses fees, updates share limit, and syncs tier", async () => {
      const externalValidatorsValue =
        sideDepositedDepositAmounts.reduce((acc, amt) => acc + amt, 0n) +
        consolidatorDepositAmounts.reduce((acc, amt) => acc + amt, 0n);
      const currentSettledGrowth = await dashboard.settledGrowth();
      const newSettledGrowth = currentSettledGrowth + externalValidatorsValue;
      await dashboard.connect(nodeOperator).correctSettledGrowth(newSettledGrowth, currentSettledGrowth);
      await dashboard.connect(owner).correctSettledGrowth(newSettledGrowth, currentSettledGrowth);
      expect(await dashboard.settledGrowth()).to.equal(newSettledGrowth);

      const accruedFee = await dashboard.accruedFee();
      const operatorBalanceBefore = await ethers.provider.getBalance(nodeOperator);

      const tx = await dashboard.connect(nodeOperator).disburseFee();
      const receipt = (await tx.wait()) as ContractTransactionReceipt;
      const gasCost = receipt.gasPrice * receipt.cumulativeGasUsed;

      expect(await ethers.provider.getBalance(nodeOperator)).to.equal(operatorBalanceBefore + accruedFee - gasCost);

      const newShareLimit = ether("600");
      await operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, newShareLimit);
      await expect(dashboard.connect(owner).updateShareLimit(newShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );
      expect((await vaultHub.vaultConnection(stakingVault)).shareLimit).to.equal(newShareLimit);

      await operatorGrid.connect(agent).alterTiers(
        [tier1Id],
        [
          {
            shareLimit: SHARE_LIMIT_TIER1,
            reserveRatioBP: RESERVE_RATIO_TIER1_BP,
            forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_TIER1_BP,
            infraFeeBP: 4_00n,
            liquidityFeeBP: 3_00n,
            reservationFeeBP: RESERVATION_FEE_BP,
          },
        ],
      );
      const tierAfterAlter = await operatorGrid.tier(tier1Id);
      expect(tierAfterAlter.infraFeeBP).to.equal(4_00n);
      expect(tierAfterAlter.liquidityFeeBP).to.equal(3_00n);
      expect(tierAfterAlter.forcedRebalanceThresholdBP).to.equal(FORCED_REBALANCE_THRESHOLD_TIER1_BP);

      await operatorGrid.connect(nodeOperator).syncTier(stakingVault);
      await expect(dashboard.connect(owner).syncTier()).to.emit(vaultHub, "VaultConnectionUpdated");

      const connection = await vaultHub.vaultConnection(stakingVault);
      expect(connection.infraFeeBP).to.equal(4_00n);
      expect(connection.liquidityFeeBP).to.equal(3_00n);
    });

    it("manages PDG roles and guarantor refund flow", async () => {
      const role = await dashboard.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE();
      await dashboard.connect(nodeOperator).grantRole(role, delegatedDepositor.address);
      expect(await dashboard.hasRole(role, delegatedDepositor.address)).to.equal(true);

      await predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(delegatedDepositor.address);
      expect(await predepositGuarantee.nodeOperatorDepositor(nodeOperator)).to.equal(delegatedDepositor.address);

      const balanceBeforeSecondTopUp = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
      expect(balanceBeforeSecondTopUp.locked).to.equal(0n);
      await predepositGuarantee.connect(guarantor).topUpNodeOperatorBalance(nodeOperator, {
        value: ether("2"),
      });
      const pdgBalanceAfterSecondTopUp = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
      expect(pdgBalanceAfterSecondTopUp.total).to.equal(balanceBeforeSecondTopUp.total + ether("2"));
      expect(pdgBalanceAfterSecondTopUp.locked).to.equal(0n);

      const newGuarantor = stranger;
      await predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(newGuarantor.address);
      expect(await predepositGuarantee.nodeOperatorGuarantor(nodeOperator)).to.equal(newGuarantor.address);
      const pdgBalanceAfterSetGuarantor = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
      expect(pdgBalanceAfterSetGuarantor.total).to.equal(0n);
      expect(pdgBalanceAfterSetGuarantor.locked).to.equal(0n);

      const claimable = await predepositGuarantee.claimableRefund(guarantor.address);
      expect(claimable).to.be.gt(0n);

      const balanceBefore = await ethers.provider.getBalance(nodeOperator);
      const tx = await predepositGuarantee.connect(guarantor).claimGuarantorRefund(nodeOperator);
      await tx.wait();

      expect(await ethers.provider.getBalance(nodeOperator)).to.equal(balanceBefore + claimable);
      expect(await predepositGuarantee.claimableRefund(guarantor.address)).to.equal(0n);
      const pdgBalanceAfterRefund = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
      expect(pdgBalanceAfterRefund.total).to.equal(0n);
      expect(pdgBalanceAfterRefund.locked).to.equal(0n);
    });

    it("handles multi-vault operations and validator ejection", async () => {
      const result2 = await createVaultProxyWithoutConnectingToVaultHub(
        nodeOperator,
        stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
        VAULT_NODE_OPERATOR_FEE,
        CONFIRM_EXPIRY,
      );

      const stakingVault2 = result2.vault;
      const dashboard2 = result2.dashboard;
      const stakingVault2Address = await stakingVault2.getAddress();

      await operatorGrid.connect(nodeOperator).changeTier(stakingVault2Address, tier1Id, ether("400"));
      await dashboard2.connect(owner).connectAndAcceptTier(tier1Id, ether("400"), { value: VAULT_CONNECTION_DEPOSIT });

      expect(await vaultHub.isVaultConnected(stakingVault2Address)).to.equal(true);
      const [, tierVault2Id, tierVault2ShareLimit] = await operatorGrid.vaultTierInfo(stakingVault2Address);
      expect(tierVault2Id).to.equal(tier1Id);
      expect(tierVault2ShareLimit).to.equal(ether("1000"));
      const connectionVault2 = await vaultHub.vaultConnection(stakingVault2Address);
      expect(connectionVault2.shareLimit).to.equal(ether("400"));

      const groupAfter = await operatorGrid.group(nodeOperator);
      const liabilityFromVault1 = await vaultHub.liabilityShares(stakingVault);
      expect(groupAfter.liabilityShares).to.equal(liabilityFromVault1);

      const pubkey = hexlify(guaranteedValidators[0].container.pubkey);
      const fee = await stakingVault.calculateValidatorWithdrawalFee(1n);

      await expect(stakingVault.connect(nodeOperator).ejectValidators(pubkey, nodeOperator, { value: fee })).to.emit(
        stakingVault,
        "ValidatorEjectionsTriggered",
      );
    });

    it("handles tier permutations across tiers", async () => {
      const tierAltShareLimit = ether("800");

      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, tier2Id, tierAltShareLimit);
      const canApplyAlt = await dashboard.connect(owner).changeTier.staticCall(tier2Id, tierAltShareLimit);
      expect(canApplyAlt).to.equal(true);
      await expect(dashboard.connect(owner).changeTier(tier2Id, tierAltShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const [, tierAfterId, tierAfterShareLimit] = await operatorGrid.vaultTierInfo(stakingVault);
      const connectionAfterAlt = await vaultHub.vaultConnection(stakingVault);
      expect(tierAfterId).to.equal(tier2Id);
      expect(tierAfterShareLimit).to.equal(SHARE_LIMIT_TIER2);
      expect(connectionAfterAlt.shareLimit).to.equal(tierAltShareLimit);

      const tierPrimaryShareLimit = ether("900");
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, tier1Id, tierPrimaryShareLimit);
      const canApplyPrimary = await dashboard.connect(owner).changeTier.staticCall(tier1Id, tierPrimaryShareLimit);
      expect(canApplyPrimary).to.equal(true);
      await expect(dashboard.connect(owner).changeTier(tier1Id, tierPrimaryShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const [, tierFinalId, tierFinalShareLimit] = await operatorGrid.vaultTierInfo(stakingVault);
      const connectionAfterPrimary = await vaultHub.vaultConnection(stakingVault);
      expect(tierFinalId).to.equal(tier1Id);
      expect(tierFinalShareLimit).to.equal(SHARE_LIMIT_TIER1);
      expect(connectionAfterPrimary.shareLimit).to.equal(tierPrimaryShareLimit);
    });

    it("socializes bad debt between vaults", async () => {
      snapshotPostMint = await Snapshot.refresh(snapshotPostMint);

      const acceptorResult = await createVaultProxyWithoutConnectingToVaultHub(
        nodeOperator,
        stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
        VAULT_NODE_OPERATOR_FEE,
        CONFIRM_EXPIRY,
      );

      const acceptorVault = acceptorResult.vault;
      const acceptorDashboard = acceptorResult.dashboard;
      const acceptorAddress = await acceptorVault.getAddress();

      await operatorGrid.connect(nodeOperator).changeTier(acceptorAddress, tier1Id, ether("600"));
      await acceptorDashboard.connect(owner).connectAndAcceptTier(tier1Id, ether("600"), {
        value: VAULT_CONNECTION_DEPOSIT,
      });
      expect(await vaultHub.isVaultConnected(acceptorVault)).to.equal(true);
      const [, acceptorTierId, acceptorTierShareLimit] = await operatorGrid.vaultTierInfo(acceptorVault);
      expect(acceptorTierId).to.equal(tier1Id);
      expect(acceptorTierShareLimit).to.equal(SHARE_LIMIT_TIER1);
      const acceptorConnection = await vaultHub.vaultConnection(acceptorVault);
      expect(acceptorConnection.shareLimit).to.equal(ether("600"));

      await acceptorDashboard.connect(owner).fund({ value: ether("200") });
      expect(await acceptorVault.availableBalance()).to.equal(ether("200") + VAULT_CONNECTION_DEPOSIT);

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
        await lido.connect(owner).approve(dashboard, await lido.getPooledEthByShares(shares));
        await dashboard.connect(owner).burnShares(shares);
      }
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);

      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });
      await dashboard.connect(owner).voluntaryDisconnect();
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.equal(true);

      await expect(reportVaultDataWithProof(ctx, stakingVault))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);

      const feeLeftover = await dashboard.feeLeftover();
      if (feeLeftover > 0n) {
        await dashboard.connect(nodeOperator).recoverFeeLeftover();
        expect(await dashboard.feeLeftover()).to.equal(0n);
      }

      const currentSettledGrowth = await dashboard.settledGrowth();
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, currentSettledGrowth);
      await dashboard.connect(owner).correctSettledGrowth(0n, currentSettledGrowth);
      expect(await dashboard.settledGrowth()).to.equal(0n);

      await dashboard.connect(owner).reconnectToVaultHub();
      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(true);

      await Snapshot.restore(snapshotOperational);
    });

    it("ossifies after ownership transfer", async () => {
      const shares = await vaultHub.liabilityShares(stakingVault);
      if (shares > 0n) {
        await lido.connect(owner).approve(dashboard, await lido.getPooledEthByShares(shares));
        await dashboard.connect(owner).burnShares(shares);
      }

      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(false);

      await dashboard.connect(owner).abandonDashboard(stranger.address);
      expect(await stakingVault.pendingOwner()).to.equal(stranger.address);

      await stakingVault.connect(stranger).acceptOwnership();
      expect(await stakingVault.owner()).to.equal(stranger.address);

      await stakingVault.connect(stranger).ossify();

      const proxy = await ethers.getContractAt("PinnedBeaconProxy", stakingVault);
      expect(await proxy.isOssified()).to.equal(true);
    });
  }),
);
