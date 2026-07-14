import { expect } from "chai";

import { EXTRA_DATA_TYPE_EXITED_VALIDATORS, ItemType, ONE_GWEI, prepareExtraData } from "lib";
import {
  ensureFirstPostMigrationReport,
  getProtocolContext,
  norEnsureDepositedOperatorKeys,
  normalizeWithdrawalVaultBaseline,
  ProtocolContext,
  updateOracleReportLimits,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { reportWithoutExtraData } from "lib/protocol/helpers/accounting";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { Snapshot } from "test/suite";

/**
 * Integration tests for the extra-data transaction limits of the sanity checker,
 * exercised through the real AccountingOracle.submitReportExtraDataList path.
 *
 * The extra-data items reference real NOR operators with deposited validators, so the
 * items are fully processable: the limits are checked after the items loop, and the
 * whole transaction reverts on the sanity check.
 */
describe("Integration: AccountingOracle extra data limits", () => {
  let ctx: ProtocolContext;

  let snapshot: string;
  let originalState: string;

  // Two NOR operators with at least one non-exited deposited validator each
  let operatorIds: bigint[];

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    // reportWithoutExtraData reports the withdrawal vault as zero, so the ORSC
    // baseline must be normalized to zero first
    await ensureFirstPostMigrationReport(ctx);
    await normalizeWithdrawalVaultBaseline(ctx, 0n);

    const { nor } = ctx.contracts;
    const operatorA = await norEnsureDepositedOperatorKeys(ctx, nor, NOR_MODULE_ID, 1n);
    const operatorB = await norEnsureDepositedOperatorKeys(ctx, nor, NOR_MODULE_ID, 1n, {
      excludeOperatorIds: [operatorA.operatorId],
    });
    operatorIds = [operatorA.operatorId, operatorB.operatorId].sort((a, b) => (a < b ? -1 : 1));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  /** One exited-validators extra-data entry (current exited + 1) per operator. */
  const buildExitedEntries = async () => {
    const { nor } = ctx.contracts;

    const entries = [];
    for (const operatorId of operatorIds) {
      const summary = await nor.getNodeOperatorSummary(operatorId);
      entries.push({ operatorId, exitedCount: summary.totalExitedValidators + 1n });
    }

    const norSummary = await nor.getStakingModuleSummary();
    const moduleNewlyExited = BigInt(entries.length);

    return {
      entries,
      numExitedValidatorsByStakingModule: [norSummary.totalExitedValidators + moduleNewlyExited],
      stakingModuleIdsWithNewlyExitedValidators: [NOR_MODULE_ID],
    };
  };

  /**
   * Submit the main report committing to the extra data, carrying the deposits accumulated
   * on the fork forward as CL pending balance (same arithmetic as reportWithoutClActivation),
   * so the sanity checker does not treat them as activated validators.
   */
  const submitMainReport = async (
    numExitedValidatorsByStakingModule: bigint[],
    stakingModuleIdsWithNewlyExitedValidators: bigint[],
    extraData: Parameters<typeof reportWithoutExtraData>[3],
  ) => {
    const { lido } = ctx.contracts;

    await waitNextAvailableReportTime(ctx);
    const { clPendingBalanceAtLastReport, depositedSinceLastReport } = await lido.getBalanceStats();

    return reportWithoutExtraData(
      ctx,
      numExitedValidatorsByStakingModule,
      stakingModuleIdsWithNewlyExitedValidators,
      extraData,
      {
        waitNextReportTime: false,
        clDiff: depositedSinceLastReport,
        clPendingBalanceGwei: (clPendingBalanceAtLastReport + depositedSinceLastReport) / ONE_GWEI,
      },
    );
  };

  it("Should revert with TooManyItemsPerExtraDataTransaction when a transaction exceeds maxItemsPerExtraDataTransaction", async () => {
    const { accountingOracle, oracleReportSanityChecker } = ctx.contracts;

    await updateOracleReportLimits(ctx, { maxItemsPerExtraDataTransaction: 1n });

    const { entries, numExitedValidatorsByStakingModule, stakingModuleIdsWithNewlyExitedValidators } =
      await buildExitedEntries();

    // Two single-operator items packed into one transaction (chunk) against the limit of 1
    const items: ItemType[] = entries.map(({ operatorId, exitedCount }) => ({
      moduleId: Number(NOR_MODULE_ID),
      nodeOpIds: [Number(operatorId)],
      keysCounts: [Number(exitedCount)],
      type: EXTRA_DATA_TYPE_EXITED_VALIDATORS,
    }));
    const extraData = prepareExtraData(items, { maxItemsPerChunk: items.length });
    expect(extraData.extraDataChunks.length).to.equal(1);

    const { submitter, extraDataChunks } = await submitMainReport(
      numExitedValidatorsByStakingModule,
      stakingModuleIdsWithNewlyExitedValidators,
      extraData,
    );

    await expect(accountingOracle.connect(submitter).submitReportExtraDataList(extraDataChunks[0]))
      .to.be.revertedWithCustomError(oracleReportSanityChecker, "TooManyItemsPerExtraDataTransaction")
      .withArgs(1, items.length);
  });

  it("Should revert with TooManyNodeOpsPerExtraDataItem when an item exceeds maxNodeOperatorsPerExtraDataItem", async () => {
    const { accountingOracle, oracleReportSanityChecker } = ctx.contracts;

    await updateOracleReportLimits(ctx, { maxNodeOperatorsPerExtraDataItem: 1n });

    const { entries, numExitedValidatorsByStakingModule, stakingModuleIdsWithNewlyExitedValidators } =
      await buildExitedEntries();

    // A single item carrying two node operators against the limit of 1
    const items: ItemType[] = [
      {
        moduleId: Number(NOR_MODULE_ID),
        nodeOpIds: entries.map(({ operatorId }) => Number(operatorId)),
        keysCounts: entries.map(({ exitedCount }) => Number(exitedCount)),
        type: EXTRA_DATA_TYPE_EXITED_VALIDATORS,
      },
    ];
    const extraData = prepareExtraData(items, { maxItemsPerChunk: 1 });
    expect(extraData.extraDataChunks.length).to.equal(1);

    const { submitter, extraDataChunks } = await submitMainReport(
      numExitedValidatorsByStakingModule,
      stakingModuleIdsWithNewlyExitedValidators,
      extraData,
    );

    await expect(accountingOracle.connect(submitter).submitReportExtraDataList(extraDataChunks[0]))
      .to.be.revertedWithCustomError(oracleReportSanityChecker, "TooManyNodeOpsPerExtraDataItem")
      .withArgs(0, entries.length);
  });
});
