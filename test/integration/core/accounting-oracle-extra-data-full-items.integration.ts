import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Burner__factory, IStakingModule, NodeOperatorsRegistry } from "typechain-types";

import {
  advanceChainTime,
  ether,
  EXTRA_DATA_TYPE_EXITED_VALIDATORS,
  EXTRA_DATA_TYPE_STUCK_VALIDATORS,
  findEventsWithInterfaces,
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
import {
  calcNodeOperatorRewards,
  CSM_MODULE_ID,
  NOR_MODULE_ID,
  SDVT_MODULE_ID,
} from "lib/protocol/helpers/staking-module";

import { MAX_BASIS_POINTS, Snapshot } from "test/suite";

const MIN_KEYS_PER_OPERATOR = 5n;
const MIN_OPERATORS_COUNT = 50n;

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

describe.skip("Integration: AccountingOracle extra data full items", () => {
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

    if (ctx.isScratch) {
      const { oracleReportSanityChecker } = ctx.contracts;
      // Need this to pass the annual balance increase limit check in sanity checker for scratch deploy
      // with not that much TVL
      await setAnnualBalanceIncreaseLimit(oracleReportSanityChecker, MAX_BASIS_POINTS);

      // Need this to pass the annual balance / appeared validators per day
      // increase limit check in sanity checker for scratch deploy with not that much TVL
      await advanceChainTime(1n * 24n * 60n * 60n);
    }

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

    await ctx.contracts.lido.connect(await ctx.getSigner("voting")).removeStakingLimit();

    await norSdvtEnsureOperators(ctx, nor, MIN_OPERATORS_COUNT, MIN_KEYS_PER_OPERATOR);
    await advanceChainTime(1n * 24n * 60n * 60n);
    await norSdvtEnsureOperators(ctx, sdvt, MIN_OPERATORS_COUNT, MIN_KEYS_PER_OPERATOR);
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
    norStuckItems,
    norExitedItems,
    sdvtStuckItems,
    sdvtExitedItems,
    csmStuckItems,
    csmExitedItems,
  }: {
    norStuckItems: number;
    norExitedItems: number;
    sdvtStuckItems: number;
    sdvtExitedItems: number;
    csmStuckItems: number;
    csmExitedItems: number;
  }) {
    return async () => {
      const { accountingOracle, nor, sdvt, csm } = ctx.contracts;

      const modules = [
        { moduleId: NOR_MODULE_ID, module: nor },
        { moduleId: SDVT_MODULE_ID, module: sdvt },
        ...(ctx.flags.withCSM ? [{ moduleId: CSM_MODULE_ID, module: csm! }] : []),
      ];

      // Get active node operator IDs for NOR
      const norIds: bigint[] = [];
      for (let i = 0; i < Number(await nor.getNodeOperatorsCount()); i++) {
        const nodeOperator = await nor.getNodeOperator(BigInt(i), false);
        if (nodeOperator.active) {
          norIds.push(BigInt(i));
        }
      }

      // Get active node operator IDs for SDVT
      const sdvtIds: bigint[] = [];
      for (let i = 0; i < Number(await sdvt.getNodeOperatorsCount()); i++) {
        const nodeOperator = await sdvt.getNodeOperator(BigInt(i), false);
        if (nodeOperator.active) {
          sdvtIds.push(BigInt(i));
        }
      }

      expect(norIds.length).to.gte(2 * maxNodeOperatorsPerExtraDataItem);
      expect(sdvtIds.length).to.gte(2 * maxNodeOperatorsPerExtraDataItem);

      // Prepare arrays for stuck and exited keys
      const csmIds: bigint[] = [];
      for (let i = 0; i < maxNodeOperatorsPerExtraDataItem; i++) {
        csmIds.push(BigInt(i));
      }

      // Slice arrays based on item counts
      const idsExited = new Map<bigint, bigint[]>();
      const idsStuck = new Map<bigint, bigint[]>();

      idsExited.set(NOR_MODULE_ID, norIds.slice(0, norExitedItems * maxNodeOperatorsPerExtraDataItem));
      idsStuck.set(
        NOR_MODULE_ID,
        norIds.slice(
          norStuckItems * maxNodeOperatorsPerExtraDataItem,
          2 * norStuckItems * maxNodeOperatorsPerExtraDataItem,
        ),
      );

      idsExited.set(SDVT_MODULE_ID, sdvtIds.slice(0, sdvtExitedItems * maxNodeOperatorsPerExtraDataItem));
      idsStuck.set(
        SDVT_MODULE_ID,
        sdvtIds.slice(
          sdvtStuckItems * maxNodeOperatorsPerExtraDataItem,
          2 * sdvtStuckItems * maxNodeOperatorsPerExtraDataItem,
        ),
      );

      if (ctx.flags.withCSM) {
        idsExited.set(CSM_MODULE_ID, csmIds.slice(0, csmExitedItems * maxNodeOperatorsPerExtraDataItem));
        idsStuck.set(CSM_MODULE_ID, csmIds.slice(0, csmStuckItems * maxNodeOperatorsPerExtraDataItem));
      }

      const numKeysReportedByNo = new ListKeyMapHelper<bigint>(); // [moduleId, nodeOpId, type] -> numKeys

      const reportExtraItems: ItemType[] = [];

      for (const { moduleId, module } of modules) {
        const ids = idsStuck.get(moduleId)!;
        for (const id of ids) {
          const summary = await module.getNodeOperatorSummary(id);
          const numKeys = summary.stuckValidatorsCount + 1n;
          numKeysReportedByNo.set([moduleId, id, EXTRA_DATA_TYPE_STUCK_VALIDATORS], numKeys);
          reportExtraItems.push({
            moduleId: Number(moduleId),
            nodeOpIds: [Number(id)],
            keysCounts: [Number(numKeys)],
            type: EXTRA_DATA_TYPE_STUCK_VALIDATORS,
          });
        }
      }

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

      // Store initial share balances for node operators with stuck validators
      const sharesBefore = new ListKeyMapHelper<bigint>();
      for (const { moduleId, module } of modules) {
        if (moduleId === CSM_MODULE_ID) continue;

        const ids = idsStuck.get(moduleId)!;
        for (const id of ids) {
          const nodeOperator = await (module as unknown as LoadedContract<NodeOperatorsRegistry>).getNodeOperator(
            id,
            false,
          );
          sharesBefore.set([moduleId, id], await ctx.contracts.lido.sharesOf(nodeOperator.rewardAddress));
        }
      }

      const { reportTx, submitter, extraDataChunks } = await reportWithoutExtraData(
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

        // Check module stuck validators, penalties and rewards
        const moduleIdsStuck = idsStuck.get(moduleId)!;
        for (const opId of moduleIdsStuck) {
          // Verify stuck validators count matches expected
          const operatorSummary = await module.getNodeOperatorSummary(opId);
          const numExpectedStuck = numKeysReportedByNo.get([moduleId, opId, EXTRA_DATA_TYPE_STUCK_VALIDATORS]);
          expect(operatorSummary.stuckValidatorsCount).to.equal(numExpectedStuck);
        }

        if (moduleId === CSM_MODULE_ID) {
          continue;
        }
        const moduleNor = module as unknown as LoadedContract<NodeOperatorsRegistry>;

        if (moduleIdsStuck.length > 0) {
          // Find the TransferShares event for module rewards
          const receipt = await reportTx.wait();
          const transferSharesEvents = await findEventsWithInterfaces(receipt!, "TransferShares", [
            ctx.contracts.lido.interface,
          ]);
          const moduleRewardsEvent = transferSharesEvents.find((e) => e.args.to === module.address);
          const moduleRewards = moduleRewardsEvent ? moduleRewardsEvent.args.sharesValue : 0n;

          let modulePenaltyShares = 0n;

          // Check each stuck node operator
          for (const opId of moduleIdsStuck) {
            // Verify operator is penalized
            expect(await moduleNor.isOperatorPenalized(opId)).to.be.true;

            // Get operator reward address and current shares balance
            const operator = await moduleNor.getNodeOperator(opId, false);
            const sharesAfter = await ctx.contracts.lido.sharesOf(operator.rewardAddress);

            // Calculate expected rewards
            const rewardsAfter = await calcNodeOperatorRewards(
              moduleNor as unknown as LoadedContract<IStakingModule>,
              opId,
              moduleRewards,
            );

            // Verify operator received only half the rewards (due to penalty)
            const sharesDiff = sharesAfter - sharesBefore.get([moduleId, opId])!;
            const expectedReward = rewardsAfter / 2n;

            // Allow for small rounding differences (up to 2 wei)
            expect(sharesDiff).to.be.closeTo(expectedReward, 2n);

            // Track total penalty shares
            modulePenaltyShares += rewardsAfter / 2n;
          }

          // Check if penalty shares were burned
          if (modulePenaltyShares > 0n) {
            const distributeReceipt = await distributeTxReceipts[String(moduleId)];
            const burnEvents = await findEventsWithInterfaces(distributeReceipt!, "StETHBurnRequested", [
              Burner__factory.createInterface(),
            ]);
            const totalBurnedShares = burnEvents.reduce((sum, event) => sum + event.args.amountOfShares, 0n);

            // Verify that the burned shares match the penalty shares (with small tolerance for rounding)
            expect(totalBurnedShares).to.be.closeTo(modulePenaltyShares, 100n);
          }
        }
      }
    };
  }

  for (const norStuckItems of [0, 1]) {
    for (const norExitedItems of [0, 1]) {
      for (const sdvtStuckItems of [0, 1]) {
        for (const sdvtExitedItems of [0, 1]) {
          for (const csmStuckItems of withCSM() ? [0, 1] : [0]) {
            for (const csmExitedItems of withCSM() ? [0, 1] : [0]) {
              if (
                norStuckItems + norExitedItems + sdvtStuckItems + sdvtExitedItems + csmStuckItems + csmExitedItems ===
                0
              ) {
                continue;
              }
              it(
                `should process extra data with full items for all modules with norStuckItems=${norStuckItems}, norExitedItems=${norExitedItems}, sdvtStuckItems=${sdvtStuckItems}, sdvtExitedItems=${sdvtExitedItems}, csmStuckItems=${csmStuckItems}, csmExitedItems=${csmExitedItems}`,
                testReportingModuleWithMaxExtraDataItems({
                  norStuckItems,
                  norExitedItems,
                  sdvtStuckItems,
                  sdvtExitedItems,
                  csmStuckItems,
                  csmExitedItems,
                }),
              );
            }
          }
        }
      }
    }
  }
});
