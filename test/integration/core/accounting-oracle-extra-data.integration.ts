import { expect } from "chai";

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import { ethers, networkHelpers } from "lib/hardhat.js";
import { advanceChainTime, ether, findEventsWithInterfaces, hexToBytes, RewardDistributionState } from "lib/index.js";
import { EXTRA_DATA_FORMAT_LIST, type KeyType, prepareExtraData, setAnnualBalanceIncreaseLimit } from "lib/oracle.js";
import { reportWithoutExtraData, waitNextAvailableReportTime } from "lib/protocol/helpers/accounting.js";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module.js";
import { getProtocolContext, reportWithEffectiveClDiff, seedProtocolPendingBaseline, type OracleReportParams, type ProtocolContext } from "lib/protocol/index.js";

import { MAX_BASIS_POINTS, Snapshot } from "test/suite/index.js";

const MODULE_ID = NOR_MODULE_ID;
const NUM_NEWLY_EXITED_VALIDATORS = 1n;
const MAIN_REPORT_EFFECTIVE_CL_REWARD = ether("1");

describe("Integration: AccountingOracle extra data", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;

  let exitedKeys: KeyType;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [stranger] = await ethers.getSigners();
    await networkHelpers.setBalance(stranger.address, ether("1000000"));

    async function getEligibleNodeOperators(limit: number) {
      const { nor } = ctx.contracts;
      const nodeOperatorsCount = await nor.getNodeOperatorsCount();
      const operators: { id: bigint; totalExitedValidators: bigint }[] = [];

      for (let i = 0n; i < nodeOperatorsCount && operators.length < limit; i++) {
        const nodeOperator = await nor.getNodeOperator(i, false);
        if (nodeOperator.active && nodeOperator.totalDepositedValidators > nodeOperator.totalExitedValidators) {
          operators.push({ id: i, totalExitedValidators: nodeOperator.totalExitedValidators });
        }
      }

      // TODO: This assumes the live/forked NOR still has operators with deposited
      // non-exited validators. That network-state dependency is brittle and may
      // stop being true as this module winds down; replace with explicit fixture
      // setup once the legacy NOR no longer reliably satisfies this predicate.
      if (operators.length < limit) {
        throw new Error(`Expected at least ${limit} eligible NOR operators, found ${operators.length}`);
      }

      return operators;
    }

    {
      const { lido } = ctx.contracts;
      const reserveTarget = await lido.getDepositsReserveTarget();
      if (reserveTarget > 0n) {
        const agent = await ctx.getSigner("agent");
        await lido.connect(agent).setDepositsReserveTarget(0n);
      }
    }
    {
      // Prepare exited keys extra data for reusing in tests
      const { oracleReportSanityChecker } = ctx.contracts;

      // Need this to pass the annual balance increase limit check in sanity checker for scratch deploy
      // with not that much TVL
      await setAnnualBalanceIncreaseLimit(oracleReportSanityChecker, MAX_BASIS_POINTS);

      // Need this to pass the annual balance increase limit check in sanity checker for scratch deploy
      // with not that much TVL
      await advanceChainTime(15n * 24n * 60n * 60n);

      exitedKeys = {
        moduleId: Number(MODULE_ID),
        nodeOpIds: [],
        keysCounts: [],
      };
      // Add at least 2 node operators with exited validators to test chunking
      const nodeOperators = await getEligibleNodeOperators(2);
      for (const [index, nodeOperator] of nodeOperators.entries()) {
        const numExited = nodeOperator.totalExitedValidators + (index === 0 ? NUM_NEWLY_EXITED_VALIDATORS : 1n);
        exitedKeys.nodeOpIds.push(Number(nodeOperator.id));
        exitedKeys.keysCounts.push(Number(numExited));
      }
    }
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  async function assertModulesRewardDistributionState(expectedState: RewardDistributionState) {
    const { nor, sdvt } = ctx.contracts;

    const norState = await nor.getRewardDistributionState();
    const sdvtState = await sdvt.getRewardDistributionState();

    expect(norState).to.equal(expectedState, "NOR reward distribution state is incorrect");
    expect(sdvtState).to.equal(expectedState, "SDVT reward distribution state is incorrect");
  }

  async function submitMainReport() {
    const { nor } = ctx.contracts;
    // Split exitedKeys into two separate entries for different node operators to test chunking
    const firstExitedKeys = {
      moduleId: Number(MODULE_ID),
      nodeOpIds: exitedKeys.nodeOpIds.length > 0 ? [exitedKeys.nodeOpIds[0]] : [],
      keysCounts: exitedKeys.keysCounts.length > 0 ? [exitedKeys.keysCounts[0]] : [],
    };
    const secondExitedKeys = {
      moduleId: Number(MODULE_ID),
      nodeOpIds: exitedKeys.nodeOpIds.length > 1 ? [exitedKeys.nodeOpIds[1]] : [],
      keysCounts: exitedKeys.keysCounts.length > 1 ? [exitedKeys.keysCounts[1]] : [],
    };

    const extraData = prepareExtraData(
      { exitedKeys: [firstExitedKeys, secondExitedKeys] },
      { maxItemsPerChunk: 1 }, // This will create 2 chunks from 2 items
    );

    const { totalExitedValidators } = await nor.getStakingModuleSummary();

    // Add total exited validators for both entries
    const totalNewExited = NUM_NEWLY_EXITED_VALIDATORS + 1n; // First operator has 1, second has 1

    // The main report in this suite must stay reward-bearing because it drives the
    // TransferredToModule -> ReadyForDistribution state machine. Snapshot protocol
    // pending first so the original 1 ETH main report still reaches that phase path.
    await seedProtocolPendingBaseline(ctx, NOR_MODULE_ID);

    // Keep the original 1 ETH reward-bearing main report, but give the pending-backed
    // safety cap enough elapsed time after snapshotting the pending baseline.
    await advanceChainTime(15n * 24n * 60n * 60n);

    return await reportWithoutExtraData(ctx, [totalExitedValidators + totalNewExited], [NOR_MODULE_ID], extraData, {
      // Snapshot protocol pending into the previous report first, then run the original
      // reward-bearing main report so this suite still exercises
      // TransferredToModule -> ReadyForDistribution.
      effectiveClDiff: MAIN_REPORT_EFFECTIVE_CL_REWARD,
    });
  }

  it("should accept report with multiple keys per node operator (single chunk)", async () => {
    const { nor } = ctx.contracts;

    // Get initial summary
    const { totalExitedValidators } = await nor.getStakingModuleSummary();
    // Use both node operators with exited keys for a single chunk test
    const { extraDataItemsCount, extraDataChunks, extraDataChunkHashes } = prepareExtraData({
      exitedKeys: [exitedKeys], // Use all exitedKeys in one chunk
    });
    expect(extraDataChunks.length).to.equal(1);
    expect(extraDataChunkHashes.length).to.equal(1);

    const reportData: Partial<OracleReportParams> = {
      extraDataFormat: EXTRA_DATA_FORMAT_LIST,
      extraDataHash: extraDataChunkHashes[0],
      extraDataItemsCount: BigInt(extraDataItemsCount),
      extraDataList: hexToBytes(extraDataChunks[0]),
      numExitedValidatorsByStakingModule: [totalExitedValidators + NUM_NEWLY_EXITED_VALIDATORS + 1n], // Both operators
      reportElVault: false,
      stakingModuleIdsWithNewlyExitedValidators: [NOR_MODULE_ID],
    };

    const numExitedBefore = (await nor.getStakingModuleSummary()).totalExitedValidators;

    const { reportTx, extraDataTx } = await reportWithEffectiveClDiff(ctx, 0n, reportData);
    const reportReceipt = await reportTx?.wait();
    const extraDataReceipt = await extraDataTx?.wait();

    const processingStartedEvents = await findEventsWithInterfaces(reportReceipt!, "ProcessingStarted", [
      ctx.contracts.accountingOracle.interface,
    ]);
    expect(processingStartedEvents.length).to.equal(1, "Should emit ProcessingStarted event");

    const tokenRebasedEvents = await findEventsWithInterfaces(reportReceipt!, "TokenRebased", [
      ctx.contracts.lido.interface,
    ]);
    expect(tokenRebasedEvents.length).to.equal(1, "Should emit TokenRebased event");

    const extraDataSubmittedEvents = await findEventsWithInterfaces(extraDataReceipt!, "ExtraDataSubmitted", [
      ctx.contracts.accountingOracle.interface,
    ]);
    expect(extraDataSubmittedEvents.length).to.equal(1, "Should emit ExtraDataSubmitted event");
    expect(extraDataSubmittedEvents[0].args.itemsProcessed).to.equal(extraDataItemsCount);
    expect(extraDataSubmittedEvents[0].args.itemsCount).to.equal(extraDataItemsCount);

    expect((await nor.getStakingModuleSummary()).totalExitedValidators).to.equal(
      numExitedBefore + NUM_NEWLY_EXITED_VALIDATORS + 1n, // Both operators
    );
  });

  it("should accept extra data splitted into multiple chunks", async () => {
    const { accountingOracle } = ctx.contracts;

    const { submitter, extraDataChunks } = await submitMainReport();
    // Make the main-report transition explicit before extra data starts changing module state further.
    await assertModulesRewardDistributionState(RewardDistributionState.TransferredToModule);

    // Submit first chunk of extra data
    await accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[0]));

    // Check processing state after first chunk submission
    const processingStateAfterFirstExtraDataSubmitted = await accountingOracle.getProcessingState();
    expect(processingStateAfterFirstExtraDataSubmitted.extraDataSubmitted).to.be.false;
    expect(processingStateAfterFirstExtraDataSubmitted.extraDataItemsCount).to.equal(2n);
    expect(processingStateAfterFirstExtraDataSubmitted.extraDataItemsSubmitted).to.equal(1n);
    await assertModulesRewardDistributionState(RewardDistributionState.TransferredToModule);

    // Submit second chunk of extra data
    await accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[1]));

    // Check processing state after second chunk submission
    const processingStateAfterSecondExtraDataSubmitted = await accountingOracle.getProcessingState();
    expect(processingStateAfterSecondExtraDataSubmitted.extraDataSubmitted).to.be.true;
    expect(processingStateAfterSecondExtraDataSubmitted.extraDataItemsCount).to.equal(2n);
    expect(processingStateAfterSecondExtraDataSubmitted.extraDataItemsSubmitted).to.equal(2n);
    await assertModulesRewardDistributionState(RewardDistributionState.ReadyForDistribution);
  });

  it("should revert when extra data submission misses deadline", async () => {
    const { accountingOracle } = ctx.contracts;

    const { submitter, extraDataChunks } = await submitMainReport();
    // Make the main-report transition explicit before extra data starts changing module state further.
    await assertModulesRewardDistributionState(RewardDistributionState.TransferredToModule);

    // Submit first chunk of extra data
    await accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[0]));

    // Check processing state after first chunk submission
    const processingStateAfterFirstExtraDataSubmitted = await accountingOracle.getProcessingState();
    expect(processingStateAfterFirstExtraDataSubmitted.extraDataSubmitted).to.be.false;
    expect(processingStateAfterFirstExtraDataSubmitted.extraDataItemsCount).to.equal(2n);
    expect(processingStateAfterFirstExtraDataSubmitted.extraDataItemsSubmitted).to.equal(1n);
    await assertModulesRewardDistributionState(RewardDistributionState.TransferredToModule);

    const processingDeadlineTime = processingStateAfterFirstExtraDataSubmitted.processingDeadlineTime;

    await waitNextAvailableReportTime(ctx);

    // Attempt to submit first chunk again after deadline
    await expect(accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[0])))
      .to.be.revertedWithCustomError(accountingOracle, "ProcessingDeadlineMissed")
      .withArgs(processingDeadlineTime);

    // Attempt to submit second chunk after deadline
    await expect(accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[1])))
      .to.be.revertedWithCustomError(accountingOracle, "ProcessingDeadlineMissed")
      .withArgs(processingDeadlineTime);
  });

  it("should revert when extra data submission has unexpected hash", async () => {
    const { accountingOracle } = ctx.contracts;

    const { submitter, extraDataChunks, extraDataChunkHashes } = await submitMainReport();

    // Submit second chunk of extra data before first one
    await expect(accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[1])))
      .to.be.revertedWithCustomError(accountingOracle, "UnexpectedExtraDataHash")
      .withArgs(extraDataChunkHashes[0], extraDataChunkHashes[1]);

    // Submit first chunk of extra data (correct order)
    await accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[0]));

    // Try to submit first chunk again (should expect second chunk hash now)
    await expect(accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[0])))
      .to.be.revertedWithCustomError(accountingOracle, "UnexpectedExtraDataHash")
      .withArgs(extraDataChunkHashes[1], extraDataChunkHashes[0]);

    // Submit second chunk of extra data (correct order)
    await accountingOracle.connect(submitter).submitReportExtraDataList(hexToBytes(extraDataChunks[1]));

    // Check processing state after both chunks are submitted
    const processingStateAfterExtraDataSubmitted = await accountingOracle.getProcessingState();
    expect(processingStateAfterExtraDataSubmitted.extraDataSubmitted).to.be.true;
    expect(processingStateAfterExtraDataSubmitted.extraDataItemsCount).to.equal(2n);
    expect(processingStateAfterExtraDataSubmitted.extraDataItemsSubmitted).to.equal(2n);
    await assertModulesRewardDistributionState(RewardDistributionState.ReadyForDistribution);
  });
});
