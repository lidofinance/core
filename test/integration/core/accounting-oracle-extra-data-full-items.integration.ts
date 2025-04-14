import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  advanceChainTime,
  ether,
  EXTRA_DATA_TYPE_EXITED_VALIDATORS,
  EXTRA_DATA_TYPE_STUCK_VALIDATORS,
  findEventsWithInterfaces,
  impersonate,
  ItemType,
  LoadedContract,
  log,
  prepareExtraData,
  RewardDistributionState,
  setAnnualBalanceIncreaseLimit,
} from "lib";
import { getProtocolContext, ProtocolContext, withCSM } from "lib/protocol";
import { reportWithoutExtraData } from "lib/protocol/helpers/accounting";
import { NOR_MODULE_ID } from "lib/protocol/helpers/nor";
import { SDVT_MODULE_ID } from "lib/protocol/helpers/sdvt";

import { MAX_BASIS_POINTS, Snapshot } from "test/suite";

import { Burner__factory, NodeOperatorsRegistry } from "typechain-types";

const MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM = 24;
const MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION = 8;
const CSM_MODULE_ID = 3n;

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

      // Need this to pass the annual balance increase limit check in sanity checker for scratch deploy
      // with not that much TVL
      await advanceChainTime(15n * 24n * 60n * 60n);
    }

    await prepareModules();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  async function calcNodeOperatorRewards(
    module: LoadedContract,
    nodeOperatorId: bigint,
    mintedShares: bigint,
  ): Promise<bigint> {
    const operatorSummary = await module.getFunction("getNodeOperatorSummary")(nodeOperatorId);
    const moduleSummary = await module.getFunction("getStakingModuleSummary")();

    const operatorTotalActiveKeys = operatorSummary.totalDepositedValidators - operatorSummary.totalExitedValidators;
    const moduleTotalActiveKeys = moduleSummary.totalDepositedValidators - moduleSummary.totalExitedValidators;

    return (mintedShares * BigInt(operatorTotalActiveKeys)) / BigInt(moduleTotalActiveKeys);
  }

  async function fillModuleWithOldAndNewOperators(
    module: NodeOperatorsRegistry,
    evmScriptExecutor: HardhatEthersSigner,
    newKeysPerOperator: number,
    maxNodeOperatorsPerItem: number,
  ): Promise<[number, number]> {
    const { acl, stakingRouter } = ctx.contracts;
    const voting = await ctx.getSigner("voting");
    const stakingRouterSigner = await impersonate(stakingRouter.address, ether("1"));

    // Grant permission
    await acl
      .connect(voting)
      .grantPermission(
        voting.address,
        await module.getAddress(),
        ethers.keccak256(ethers.toUtf8Bytes("MANAGE_NODE_OPERATOR_ROLE")),
      );

    // Calculate new operators count
    // TODO: commend and proper number
    const operatorsCountBefore = Number(await module.getNodeOperatorsCount());
    const operatorsCountAfter = Math.max(maxNodeOperatorsPerItem, operatorsCountBefore);
    const operatorsCountAdded = Math.max(operatorsCountAfter - operatorsCountBefore, 0);

    // Add new node operators and keys
    if (operatorsCountAdded > 0) {
      await addModuleOperatorsWithKeys(module, voting, evmScriptExecutor, operatorsCountAdded, newKeysPerOperator);
    }
    log.debug("Added new node operators and keys", {
      operatorsCountAdded,
    });

    // Activate old deactivated node operators
    for (let i = 0; i < operatorsCountAfter; i++) {
      if (!(await module.getNodeOperatorIsActive(i))) {
        await module.connect(voting).activateNodeOperator(i);
      }
    }
    log.debug("Activated old node operators", {
      operatorsCountAfter,
    });

    // Add keys to old node operators
    for (let i = 0; i < operatorsCountBefore; i++) {
      const pubkeysBatch = randomPubkeysBatch(newKeysPerOperator);
      const signaturesBatch = randomSignaturesBatch(newKeysPerOperator);
      const operator = await module.getNodeOperator(i, false);
      const operatorSummary = await module.getNodeOperatorSummary(i);
      const newDepositLimit = Number(operator.totalDepositedValidators) + newKeysPerOperator;
      const operatorSigner = await impersonate(operator.rewardAddress, ether("1"));

      await module.connect(operatorSigner).addSigningKeys(i, newKeysPerOperator, pubkeysBatch, signaturesBatch);

      // Change staking limits for old node operators (change to new total added keys count)
      await module.connect(evmScriptExecutor).setNodeOperatorStakingLimit(i, newDepositLimit);

      // Remove target validators limits if active
      if (Number(operatorSummary.targetLimitMode) > 0) {
        // await nor.connect(stakingRouterSigner).updateTargetValidatorsLimits(i, 0n, 0n);
        await module.connect(stakingRouterSigner)["updateTargetValidatorsLimits(uint256,uint256,uint256)"](i, 0n, 0n);
      }
    }
    log.debug("Updated staking limits for old node operators", {
      operatorsCountBefore,
    });

    return [operatorsCountBefore, operatorsCountAdded];
  }

  function randomPubkeysBatch(count: number): string {
    // Generate random pubkeys as a concatenated hex string
    return (
      "0x" +
      Array(count)
        .fill(0)
        .map(() =>
          Array(48)
            .fill(0)
            .map(() =>
              Math.floor(Math.random() * 256)
                .toString(16)
                .padStart(2, "0"),
            )
            .join(""),
        )
        .join("")
    );
  }

  function randomSignaturesBatch(count: number): string {
    // Generate random signatures as a concatenated hex string
    return (
      "0x" +
      Array(count)
        .fill(0)
        .map(() =>
          Array(96)
            .fill(0)
            .map(() =>
              Math.floor(Math.random() * 256)
                .toString(16)
                .padStart(2, "0"),
            )
            .join(""),
        )
        .join("")
    );
  }

  async function addModuleOperatorsWithKeys(
    module: NodeOperatorsRegistry,
    votingSigner: HardhatEthersSigner,
    evmScriptExecutorSigner: HardhatEthersSigner,
    operatorsCount: number,
    keysPerOperator: number,
  ): Promise<void> {
    for (let i = 0; i < operatorsCount; i++) {
      const operatorName = `Operator ${Date.now()}-${i}`;
      const rewardAddress = ethers.Wallet.createRandom().address;
      const operatorSigner = await impersonate(rewardAddress, ether("1"));
      // Add node operator
      await module.connect(votingSigner).addNodeOperator(operatorName, rewardAddress);

      const operatorId = Number(await module.getNodeOperatorsCount()) - 1;

      // Add signing keys
      const pubkeysBatch = randomPubkeysBatch(keysPerOperator);
      const signaturesBatch = randomSignaturesBatch(keysPerOperator);

      await module.connect(operatorSigner).addSigningKeys(operatorId, keysPerOperator, pubkeysBatch, signaturesBatch);

      // Set staking limit
      await module.connect(evmScriptExecutorSigner).setNodeOperatorStakingLimit(operatorId, keysPerOperator);
    }
  }

  async function depositBufferForKeys(norKeysToDeposit: number, sdvtKeysToDeposit: number): Promise<void> {
    const { stakingRouter, lido, depositSecurityModule } = ctx.contracts;
    const dsmSigner = await impersonate(depositSecurityModule.address, ether("1"));
    const voting = await ctx.getSigner("voting");

    // Calculate total depositable keys
    let totalDepositableKeys = 0n;
    const moduleDigests = await stakingRouter.getAllStakingModuleDigests();

    for (const digest of moduleDigests) {
      const summary = digest[3]; // Get the summary from the digest tuple
      const depositableKeys = summary[2]; // Get depositable keys from summary tuple
      totalDepositableKeys += depositableKeys;
    }

    // Remove staking limit
    await lido.connect(voting).removeStakingLimit();

    // Fill deposit buffer
    await fillDepositBuffer(totalDepositableKeys);

    const keysPerDeposit = 50;

    // Deposits for NOR
    const norTimes = Math.ceil(norKeysToDeposit / keysPerDeposit);
    for (let i = 0; i < norTimes; i++) {
      await lido.connect(dsmSigner).deposit(keysPerDeposit, NOR_MODULE_ID, "0x");
    }

    // Deposits for SDVT
    const sdvtTimes = Math.ceil(sdvtKeysToDeposit / keysPerDeposit);
    for (let i = 0; i < sdvtTimes; i++) {
      await lido.connect(dsmSigner).deposit(keysPerDeposit, SDVT_MODULE_ID, "0x");
    }
  }

  async function fillDepositBuffer(totalKeys: bigint): Promise<void> {
    const { lido } = ctx.contracts;

    // Calculate required ETH for deposits (32 ETH per validator)
    const requiredEth = ether(String(totalKeys * 32n));

    // Get current balance
    const currentBalance = await ethers.provider.getBalance(lido.target);

    // If we need more ETH, send it to the contract
    if (currentBalance < requiredEth) {
      const [depositor] = await ethers.getSigners();
      await setBalance(depositor.address, requiredEth * 2n);

      // Send ETH to Lido contract
      await depositor.sendTransaction({
        to: lido.target,
        value: requiredEth - currentBalance,
      });
    }
  }

  async function prepareModules() {
    const { nor, sdvt } = ctx.contracts;
    const evmScriptExecutor = await ctx.getSigner("easyTrack");

    // Constants
    const numKeysPerOperator = 5;
    const maxNodeOperatorsPerExtraDataItem = 50;

    // Fill NOR with new operators and keys
    const [norCountBefore, addedNorOperatorsCount] = await fillModuleWithOldAndNewOperators(
      nor,
      evmScriptExecutor,
      numKeysPerOperator,
      maxNodeOperatorsPerExtraDataItem,
    );

    // Fill SDVT with new operators and keys
    const [sdvtCountBefore, addedSdvtOperatorsCount] = await fillModuleWithOldAndNewOperators(
      sdvt,
      evmScriptExecutor,
      numKeysPerOperator,
      maxNodeOperatorsPerExtraDataItem,
    );

    // Deposit for new added keys from buffer
    const keysForNor = addedNorOperatorsCount * numKeysPerOperator + norCountBefore * numKeysPerOperator;
    const keysForSdvt = addedSdvtOperatorsCount * numKeysPerOperator + sdvtCountBefore * numKeysPerOperator;

    await depositBufferForKeys(keysForNor, keysForSdvt);

    return {
      norCountBefore,
      addedNorOperatorsCount,
      sdvtCountBefore,
      addedSdvtOperatorsCount,
      keysForNor,
      keysForSdvt,
    };
  }

  async function distributeReward(module: LoadedContract, fromSigner: HardhatEthersSigner) {
    // Get initial reward distribution state
    const rewardDistributionState = await module.getFunction("getRewardDistributionState")();
    expect(rewardDistributionState).to.equal(RewardDistributionState.ReadyForDistribution);

    // Distribute rewards
    const tx = await module.connect(fromSigner).getFunction("distributeReward")();

    // Verify reward distribution state after
    const finalState = await module.getFunction("getRewardDistributionState")();
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
    // TODO: add CSM part when finishing this test for upgrade
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

      expect(norIds.length).to.gte(2 * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM);
      expect(sdvtIds.length).to.gte(2 * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM);

      // Prepare arrays for stuck and exited keys
      const csmIds: bigint[] = [];
      for (let i = 0; i < MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM; i++) {
        csmIds.push(BigInt(i));
      }

      // Slice arrays based on item counts
      const idsExited = new Map<bigint, bigint[]>();
      const idsStuck = new Map<bigint, bigint[]>();

      idsExited.set(NOR_MODULE_ID, norIds.slice(0, norExitedItems * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM));
      idsStuck.set(
        NOR_MODULE_ID,
        norIds.slice(
          norStuckItems * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM,
          2 * norStuckItems * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM,
        ),
      );

      idsExited.set(SDVT_MODULE_ID, sdvtIds.slice(0, sdvtExitedItems * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM));
      idsStuck.set(
        SDVT_MODULE_ID,
        sdvtIds.slice(
          sdvtStuckItems * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM,
          2 * sdvtStuckItems * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM,
        ),
      );

      if (ctx.flags.withCSM) {
        idsExited.set(CSM_MODULE_ID, csmIds.slice(0, csmExitedItems * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM));
        idsStuck.set(CSM_MODULE_ID, csmIds.slice(0, csmStuckItems * MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM));
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

      const extraData = prepareExtraData(reportExtraItems, { maxItemsPerChunk: MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION });

      // Prepare modules with exited validators and their counts
      const modulesWithExited = [];
      const numExitedValidatorsByStakingModule = [];

      if (norExitedItems > 0) {
        modulesWithExited.push(NOR_MODULE_ID);
        const norExitedBefore = (await nor.getStakingModuleSummary()).totalExitedValidators;
        numExitedValidatorsByStakingModule.push(
          norExitedBefore + BigInt(norExitedItems) * BigInt(MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM),
        );
      }

      if (sdvtExitedItems > 0) {
        modulesWithExited.push(SDVT_MODULE_ID);
        const sdvtExitedBefore = (await sdvt.getStakingModuleSummary()).totalExitedValidators;
        numExitedValidatorsByStakingModule.push(
          sdvtExitedBefore + BigInt(sdvtExitedItems) * BigInt(MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM),
        );
      }

      if (csmExitedItems > 0 && ctx.flags.withCSM) {
        modulesWithExited.push(CSM_MODULE_ID);
        const csmExitedBefore = (await csm!.getStakingModuleSummary()).totalExitedValidators;
        numExitedValidatorsByStakingModule.push(
          csmExitedBefore + BigInt(csmExitedItems) * BigInt(MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM),
        );
      }

      // Store initial share balances for node operators with stuck validators
      const sharesBefore = new ListKeyMapHelper<bigint>();
      for (const { moduleId, module } of modules) {
        if (moduleId === CSM_MODULE_ID) continue;
        const ids = idsStuck.get(moduleId)!;
        for (const id of ids) {
          const nodeOperator = await module.getNodeOperator(id, false);
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
        distributeTxReceipts[String(moduleId)] = await distributeReward(module as unknown as LoadedContract, stranger);
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
            const rewardsAfter = await calcNodeOperatorRewards(moduleNor, opId, moduleRewards);

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
          for (const csmStuckItems of (withCSM() ? [0, 1] : [0])) {
            for (const csmExitedItems of (withCSM() ? [0, 1] : [0])) {
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
