import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { NodeOperatorsRegistry } from "typechain-types";

import {
  advanceChainTime,
  ether,
  EXTRA_DATA_TYPE_EXITED_VALIDATORS,
  ItemType,
  LoadedContract,
  log,
  prepareExtraData,
  RewardDistributionState,
  setAnnualBalanceIncreaseLimit,
} from "lib";
import { getProtocolContext, ProtocolContext, withCSM } from "lib/protocol";
import { reportWithoutExtraData } from "lib/protocol/helpers/accounting";
import { norSdvtEnsureOperators } from "lib/protocol/helpers/nor-sdvt";
import { removeStakingLimit, setModuleStakeShareLimit } from "lib/protocol/helpers/staking";
import { CSM_MODULE_ID, NOR_MODULE_ID, SDVT_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { MAX_BASIS_POINTS, Snapshot } from "test/suite";

const MIN_KEYS_PER_OPERATOR = 5n;
const MIN_OPERATORS_COUNT = 30n;

class ListKeyMapHelper<ValueType> {
  private map: Map<string, ValueType> = new Map();

  constructor() {
    this.map = new Map<string, ValueType>();
  }

  set(keys: unknown[], value: ValueType): void {
    const compositeKey = this.createKey(keys);
    this.map.set(compositeKey, value);
  }

  get(keys: unknown[]): ValueType | undefined {
    const compositeKey = this.createKey(keys);
    const result = this.map.get(compositeKey);
    if (result === undefined) {
      log.error("HelperMap: get: result is undefined for key " + compositeKey);
    }
    return result;
  }

  private createKey(keys: unknown[]): string {
    return keys.map((k) => String(k)).join("-");
  }
}

describe("Integration: AccountingOracle extra data full items", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;
  let maxNodeOperatorsPerExtraDataItem: number;
  let maxItemsPerExtraDataTransaction: number;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [stranger] = await ethers.getSigners();
    await setBalance(stranger.address, ether("1000000"));

    const { oracleReportSanityChecker } = ctx.contracts;
    // Need this to pass the annual balance increase limit check in sanity checker for scratch deploy
    // with not that much TVL
    await setAnnualBalanceIncreaseLimit(oracleReportSanityChecker, MAX_BASIS_POINTS);

    // Need this to pass the annual balance / appeared validators per day
    // increase limit check in sanity checker for scratch deploy with not that much TVL
    await advanceChainTime(1n * 24n * 60n * 60n);

    await prepareModules();

    const limits = await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits();
    maxNodeOperatorsPerExtraDataItem = Number(limits.maxNodeOperatorsPerExtraDataItem);
    maxItemsPerExtraDataTransaction = Number(limits.maxItemsPerExtraDataTransaction);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  async function prepareModules() {
    const { nor, sdvt } = ctx.contracts;

    await removeStakingLimit(ctx);

    await setModuleStakeShareLimit(ctx, SDVT_MODULE_ID, 50_00n);

    await norSdvtEnsureOperators(ctx, nor, MIN_OPERATORS_COUNT, MIN_KEYS_PER_OPERATOR, 2n);
    await advanceChainTime(1n * 24n * 60n * 60n);

    await norSdvtEnsureOperators(ctx, sdvt, MIN_OPERATORS_COUNT, MIN_KEYS_PER_OPERATOR, 2n);
    await advanceChainTime(1n * 24n * 60n * 60n);
  }

  async function distributeReward(module: LoadedContract<NodeOperatorsRegistry>, fromSigner: HardhatEthersSigner) {
    // Get initial reward distribution state
    const rewardDistributionState = await module.getRewardDistributionState();
    expect(rewardDistributionState).to.equal(RewardDistributionState.ReadyForDistribution);

    // Distribute rewards
    const tx = await module.connect(fromSigner).distributeReward();

    // Verify reward distribution state after
    const finalState = await module.getRewardDistributionState();
    expect(finalState).to.equal(RewardDistributionState.Distributed);

    return (await tx.wait()) as ContractTransactionReceipt;
  }

  async function assertModulesRewardDistributionState(expectedState: RewardDistributionState) {
    const { nor, sdvt } = ctx.contracts;

    const norState = await nor.getRewardDistributionState();
    const sdvtState = await sdvt.getRewardDistributionState();

    expect(norState).to.equal(expectedState, "NOR reward distribution state is incorrect");
    expect(sdvtState).to.equal(expectedState, "SDVT reward distribution state is incorrect");
  }

  function testReportingModuleWithMaxExtraDataItems({
    norExitedItems,
    sdvtExitedItems,
    csmExitedItems,
  }: {
    norExitedItems: number;
    sdvtExitedItems: number;
    csmExitedItems: number;
  }) {
    return async () => {
      const { accountingOracle, nor, sdvt, csm } = ctx.contracts;

      const modules = [
        { moduleId: NOR_MODULE_ID, module: nor },
        { moduleId: SDVT_MODULE_ID, module: sdvt },
        ...(ctx.flags.withCSM ? [{ moduleId: CSM_MODULE_ID, module: csm! }] : []),
      ];

      const noIdsByModule = new Map<bigint, bigint[]>();
      for (const { moduleId, module } of modules) {
        if (moduleId === CSM_MODULE_ID) continue;
        const ids: bigint[] = [];
        const count = Number(await module.getNodeOperatorsCount());
        for (let i = 0; i < count; i++) {
          const nodeOperator = await (module as unknown as LoadedContract<NodeOperatorsRegistry>).getNodeOperator(
            BigInt(i),
            false,
          );
          if (nodeOperator.active && nodeOperator.totalDepositedValidators - nodeOperator.totalExitedValidators >= 1n) {
            ids.push(BigInt(i));
          }
        }
        noIdsByModule.set(moduleId, ids);
      }
      const norIds = noIdsByModule.get(NOR_MODULE_ID)!;
      const sdvtIds = noIdsByModule.get(SDVT_MODULE_ID)!;

      expect(norIds.length).to.gte(maxNodeOperatorsPerExtraDataItem);
      expect(sdvtIds.length).to.gte(maxNodeOperatorsPerExtraDataItem);

      // Prepare arrays for stuck and exited keys
      const csmIds: bigint[] = [];
      for (let i = 0; i < maxNodeOperatorsPerExtraDataItem; i++) {
        csmIds.push(BigInt(i));
      }

      // Slice arrays based on item counts
      const idsExited = new Map<bigint, bigint[]>();

      idsExited.set(NOR_MODULE_ID, norIds.slice(0, norExitedItems * maxNodeOperatorsPerExtraDataItem));
      idsExited.set(SDVT_MODULE_ID, sdvtIds.slice(0, sdvtExitedItems * maxNodeOperatorsPerExtraDataItem));

      if (ctx.flags.withCSM) {
        idsExited.set(CSM_MODULE_ID, csmIds.slice(0, csmExitedItems * maxNodeOperatorsPerExtraDataItem));
      }

      const numKeysReportedByNo = new ListKeyMapHelper<bigint>(); // [moduleId, nodeOpId, type] -> numKeys

      const reportExtraItems: ItemType[] = [];

      for (const { moduleId, module } of modules) {
        const ids = idsExited.get(moduleId)!;
        for (const id of ids) {
          const summary = await module.getNodeOperatorSummary(id);
          const numKeys = summary.totalExitedValidators + 1n;
          numKeysReportedByNo.set([moduleId, id, EXTRA_DATA_TYPE_EXITED_VALIDATORS], numKeys);
          reportExtraItems.push({
            moduleId: Number(moduleId),
            nodeOpIds: [Number(id)],
            keysCounts: [Number(numKeys)],
            type: EXTRA_DATA_TYPE_EXITED_VALIDATORS,
          });
        }
      }

      const extraData = prepareExtraData(reportExtraItems, { maxItemsPerChunk: maxItemsPerExtraDataTransaction });

      // Prepare modules with exited validators and their counts
      const modulesWithExited = [];
      const numExitedValidatorsByStakingModule = [];

      if (norExitedItems > 0) {
        modulesWithExited.push(NOR_MODULE_ID);
        const norExitedBefore = (await nor.getStakingModuleSummary()).totalExitedValidators;
        numExitedValidatorsByStakingModule.push(
          norExitedBefore + BigInt(norExitedItems) * BigInt(maxNodeOperatorsPerExtraDataItem),
        );
      }

      if (sdvtExitedItems > 0) {
        modulesWithExited.push(SDVT_MODULE_ID);
        const sdvtExitedBefore = (await sdvt.getStakingModuleSummary()).totalExitedValidators;
        numExitedValidatorsByStakingModule.push(
          sdvtExitedBefore + BigInt(sdvtExitedItems) * BigInt(maxNodeOperatorsPerExtraDataItem),
        );
      }

      if (csmExitedItems > 0 && ctx.flags.withCSM) {
        modulesWithExited.push(CSM_MODULE_ID);
        const csmExitedBefore = (await csm!.getStakingModuleSummary()).totalExitedValidators;
        numExitedValidatorsByStakingModule.push(
          csmExitedBefore + BigInt(csmExitedItems) * BigInt(maxNodeOperatorsPerExtraDataItem),
        );
      }

      const { submitter, extraDataChunks } = await reportWithoutExtraData(
        ctx,
        numExitedValidatorsByStakingModule,
        modulesWithExited,
        extraData,
      );

      await assertModulesRewardDistributionState(RewardDistributionState.TransferredToModule);

      for (let i = 0; i < extraDataChunks.length; i++) {
        await accountingOracle.connect(submitter).submitReportExtraDataList(extraDataChunks[i]);
      }

      const processingState = await accountingOracle.getProcessingState();
      expect(processingState.extraDataItemsCount).to.equal(extraData.extraDataItemsCount);
      expect(processingState.extraDataItemsSubmitted).to.equal(extraData.extraDataItemsCount);
      expect(processingState.extraDataSubmitted).to.be.true;

      // Distribute rewards
      const distributeTxReceipts: Record<string, ContractTransactionReceipt> = {};
      for (const { moduleId, module } of modules) {
        if (moduleId === CSM_MODULE_ID) continue;
        distributeTxReceipts[String(moduleId)] = await distributeReward(
          module as unknown as LoadedContract<NodeOperatorsRegistry>,
          stranger,
        );
      }

      for (const { moduleId, module } of modules) {
        const moduleIdsExited = idsExited.get(moduleId)!;
        for (const id of moduleIdsExited) {
          const summary = await module.getNodeOperatorSummary(id);
          const numExpectedExited = numKeysReportedByNo.get([moduleId, id, EXTRA_DATA_TYPE_EXITED_VALIDATORS]);
          expect(summary.totalExitedValidators).to.equal(numExpectedExited);
        }
      }
    };
  }

  for (const norExitedItems of [0, 1]) {
    for (const sdvtExitedItems of [0, 1]) {
      for (const csmExitedItems of withCSM() ? [0, 1] : [0]) {
        if (norExitedItems + sdvtExitedItems + csmExitedItems === 0) {
          continue;
        }
        it(
          `should process extra data with full items for all modules with norExitedItems=${norExitedItems}, sdvtExitedItems=${sdvtExitedItems}, csmExitedItems=${csmExitedItems}`,
          testReportingModuleWithMaxExtraDataItems({
            norExitedItems,
            sdvtExitedItems,
            csmExitedItems,
          }),
        );
      }
    }
  }
});
