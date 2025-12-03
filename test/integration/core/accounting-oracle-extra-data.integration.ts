import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { advanceChainTime, ether, findEventsWithInterfaces, hexToBytes, RewardDistributionState } from "lib";
import { EXTRA_DATA_FORMAT_LIST, KeyType, prepareExtraData, setAnnualBalanceIncreaseLimit } from "lib/oracle";
import { getProtocolContext, OracleReportParams, ProtocolContext, report } from "lib/protocol";
import { reportWithoutExtraData, waitNextAvailableReportTime } from "lib/protocol/helpers/accounting";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { MAX_BASIS_POINTS, Snapshot } from "test/suite";

const MODULE_ID = NOR_MODULE_ID;
const NUM_NEWLY_EXITED_VALIDATORS = 1n;
const MAINNET_NOR_ADDRESS = "0x55032650b14df07b85bf18a3a3ec8e0af2e028d5".toLowerCase();

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
    await setBalance(stranger.address, ether("1000000"));

    async function getExitedCount(nodeOperatorId: bigint): Promise<bigint> {
      const { nor } = ctx.contracts;
      const nodeOperator = await nor.getNodeOperator(nodeOperatorId, false);
      return nodeOperator.totalExitedValidators;
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

      let firstNodeOperatorInRange = 0;
      // Workaround for Mainnet
      if (ctx.contracts.nor.address.toLowerCase() === MAINNET_NOR_ADDRESS) {
        firstNodeOperatorInRange = 20;
      }

      const numNodeOperators = Math.min(10, Number(await ctx.contracts.nor.getNodeOperatorsCount()));
      exitedKeys = {
        moduleId: Number(MODULE_ID),
        nodeOpIds: [],
        keysCounts: [],
      };
      // Add at least 2 node operators with exited validators to test chunking
      for (let i = firstNodeOperatorInRange; i < firstNodeOperatorInRange + Math.min(2, numNodeOperators); i++) {
        const oldNumExited = await getExitedCount(BigInt(i));
        const numExited = oldNumExited + (i === firstNodeOperatorInRange ? NUM_NEWLY_EXITED_VALIDATORS : 1n);
        exitedKeys.nodeOpIds.push(Number(i));
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

    return await reportWithoutExtraData(ctx, [totalExitedValidators + totalNewExited], [NOR_MODULE_ID], extraData);
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
      clDiff: 0n,
      excludeVaultsBalances: true,
      extraDataFormat: EXTRA_DATA_FORMAT_LIST,
      extraDataHash: extraDataChunkHashes[0],
      extraDataItemsCount: BigInt(extraDataItemsCount),
      extraDataList: hexToBytes(extraDataChunks[0]),
      numExitedValidatorsByStakingModule: [totalExitedValidators + NUM_NEWLY_EXITED_VALIDATORS + 1n], // Both operators
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
      numExitedBefore + NUM_NEWLY_EXITED_VALIDATORS + 1n, // Both operators
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
