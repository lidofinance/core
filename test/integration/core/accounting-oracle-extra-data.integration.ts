import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { advanceChainTime, ether, findEventsWithInterfaces, hexToBytes, RewardDistributionState } from "lib";
import { EXTRA_DATA_FORMAT_LIST, KeyType, prepareExtraData, setAnnualBalanceIncreaseLimit } from "lib/oracle";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { report } from "lib/protocol/helpers";
import {
  OracleReportOptions,
  reportWithoutExtraData,
  waitNextAvailableReportTime,
} from "lib/protocol/helpers/accounting";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { Snapshot } from "test/suite";

const MODULE_ID = NOR_MODULE_ID;
const NUM_NEWLY_EXITED_VALIDATORS = 1n;
const MAX_BASIS_POINTS = 100_00n;

describe("Integration: AccountingOracle extra data", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;

  let stuckKeys: KeyType;
  let exitedKeys: KeyType;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [stranger] = await ethers.getSigners();
    await setBalance(stranger.address, ether("1000000"));

    async function getExitedCount(nodeOperatorId: bigint): Promise<bigint> {
      const { nor } = ctx.contracts;
      const nodeOperator = await nor.getNodeOperator(nodeOperatorId, false);
      return nodeOperator.totalExitedValidators;
    }

    {
      // Prepare stuck and exited keys extra data for reusing in tests
      const { oracleReportSanityChecker } = ctx.contracts;

      if (ctx.isScratch) {
        // Need this to pass the annual balance increase limit check in sanity checker for scratch deploy
        // with not that much TVL
        await setAnnualBalanceIncreaseLimit(oracleReportSanityChecker, MAX_BASIS_POINTS);

        // Need this to pass the annual balance increase limit check in sanity checker for scratch deploy
        // with not that much TVL
        await advanceChainTime(15n * 24n * 60n * 60n);
      }

      const firstNodeOperatorInRange = ctx.isScratch ? 0 : 20;
      const numNodeOperators = Math.min(10, Number(await ctx.contracts.nor.getNodeOperatorsCount()));
      const numStuckKeys = 2;
      stuckKeys = {
        moduleId: Number(MODULE_ID),
        nodeOpIds: [],
        keysCounts: [],
      };
      exitedKeys = {
        moduleId: Number(MODULE_ID),
        nodeOpIds: [],
        keysCounts: [],
      };
      for (let i = firstNodeOperatorInRange; i < firstNodeOperatorInRange + numNodeOperators; i++) {
        const oldNumExited = await getExitedCount(BigInt(i));
        const numExited = oldNumExited + (i === firstNodeOperatorInRange ? NUM_NEWLY_EXITED_VALIDATORS : 0n);
        if (numExited !== oldNumExited) {
          exitedKeys.nodeOpIds.push(Number(i));
          exitedKeys.keysCounts.push(Number(numExited));
        } else {
          stuckKeys.nodeOpIds.push(Number(i));
          stuckKeys.keysCounts.push(numStuckKeys);
        }
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
    const extraData = prepareExtraData(
      {
        stuckKeys: [stuckKeys],
        exitedKeys: [exitedKeys],
      },
      { maxItemsPerChunk: 1 },
    );

    const { totalExitedValidators } = await nor.getStakingModuleSummary();

    return await reportWithoutExtraData(
      ctx,
      [totalExitedValidators + NUM_NEWLY_EXITED_VALIDATORS],
      [NOR_MODULE_ID],
      extraData,
    );
  }

  it("should accept report with multiple keys per node operator (single chunk)", async () => {
    const { nor } = ctx.contracts;

    // Get initial summary
    const { totalExitedValidators } = await nor.getStakingModuleSummary();

    const { extraDataItemsCount, extraDataChunks, extraDataChunkHashes } = prepareExtraData({
      stuckKeys: [stuckKeys],
      exitedKeys: [exitedKeys],
    });
    expect(extraDataChunks.length).to.equal(1);
    expect(extraDataChunkHashes.length).to.equal(1);

    const reportData: Partial<OracleReportOptions> = {
      clDiff: 0n,
      excludeVaultsBalances: true,
      extraDataFormat: EXTRA_DATA_FORMAT_LIST,
      extraDataHash: extraDataChunkHashes[0],
      extraDataItemsCount: BigInt(extraDataItemsCount),
      extraDataList: hexToBytes(extraDataChunks[0]),
      numExitedValidatorsByStakingModule: [totalExitedValidators + NUM_NEWLY_EXITED_VALIDATORS],
      stakingModuleIdsWithNewlyExitedValidators: [NOR_MODULE_ID],
    };

    const numExitedBefore = (await nor.getStakingModuleSummary()).totalExitedValidators;

    const { reportTx, extraDataTx } = await report(ctx, reportData);
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
      numExitedBefore + NUM_NEWLY_EXITED_VALIDATORS,
    );
  });

  it("should accept extra data splitted into multiple chunks", async () => {
    const { accountingOracle } = ctx.contracts;

    const { submitter, extraDataChunks } = await submitMainReport();

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
