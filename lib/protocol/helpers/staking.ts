import { ethers, ZeroAddress } from "ethers";

import {
  BigIntMath,
  certainAddress,
  ether,
  impersonate,
  log,
  ONE_GWEI,
  StakingModuleStatus,
  TOTAL_BASIS_POINTS,
} from "lib";

import { ZERO_HASH } from "test/suite";

import { ProtocolContext } from "../types";

import { report, submitReportDataWithConsensusAndEmptyExtraData } from "./accounting";

const DEPOSIT_SIZE = ether("32");

export type StakingModuleBalances = {
  validatorsBalanceGwei: bigint;
};

export type ModuleAccountingReportParams = {
  stakingModuleIdsWithUpdatedBalance: bigint[];
  validatorBalancesGweiByStakingModule: bigint[];
};

export const unpauseStaking = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;
  if (await lido.isStakingPaused()) {
    const agentSigner = await ctx.getSigner("agent");
    await lido.connect(agentSigner).resume();

    log.success("Staking contract unpaused");
  }
};

export const getStakingModuleStatuses = async (
  ctx: ProtocolContext,
): Promise<{ [moduleId: number]: StakingModuleStatus }> => {
  const { stakingRouter } = ctx.contracts;

  const stakingModulesCount = await stakingRouter.getStakingModulesCount();

  const result: { [moduleId: number]: StakingModuleStatus } = {};
  for (let moduleId = 1; moduleId <= Number(stakingModulesCount); moduleId++) {
    const statusValue = await stakingRouter.getStakingModuleStatus(moduleId);
    result[moduleId] = statusValue as unknown as StakingModuleStatus;
  }
  return result;
};

export const getStakingModuleManagerSigner = async (ctx: ProtocolContext) => {
  const { stakingRouter } = ctx.contracts;

  const role = await stakingRouter.STAKING_MODULE_MANAGE_ROLE();
  const numRoleHolders = await stakingRouter.getRoleMemberCount(role);
  if (numRoleHolders === 0n) {
    return undefined;
  }

  return await impersonate(await stakingRouter.getRoleMember(role, 0n), ether("100000"));
};

export const getStakingModuleBalances = async (
  ctx: ProtocolContext,
  moduleId: bigint,
): Promise<StakingModuleBalances> => {
  const [validatorsBalanceGwei] = await ctx.contracts.stakingRouter.getStakingModuleStateAccounting(moduleId);
  return { validatorsBalanceGwei };
};

const buildModuleAccountingReportParams = async (
  ctx: ProtocolContext,
  {
    validatorsDeltaGweiByModule = new Map<bigint, bigint>(),
  }: {
    validatorsDeltaGweiByModule?: Map<bigint, bigint>;
  } = {},
): Promise<ModuleAccountingReportParams> => {
  const { stakingRouter } = ctx.contracts;

  const stakingModuleIds = await stakingRouter.getStakingModuleIds();
  // Router balance reporting now requires all registered modules in router order.
  const stakingModuleIdsWithUpdatedBalance = [...stakingModuleIds];
  const validatorBalancesGweiByStakingModule: bigint[] = [];

  for (const moduleId of stakingModuleIds) {
    const [currentValidatorsBalanceGwei] = await stakingRouter.getStakingModuleStateAccounting(moduleId);
    const validatorsBalanceGwei = currentValidatorsBalanceGwei + (validatorsDeltaGweiByModule.get(moduleId) ?? 0n);
    validatorBalancesGweiByStakingModule.push(validatorsBalanceGwei);
  }

  return {
    stakingModuleIdsWithUpdatedBalance,
    validatorBalancesGweiByStakingModule,
  };
};

export const setModuleStakeShareLimit = async (ctx: ProtocolContext, moduleId: bigint, stakeShareLimit: bigint) => {
  const { stakingRouter } = ctx.contracts;

  const module = await stakingRouter.getStakingModule(moduleId);
  const managerSigner = await getStakingModuleManagerSigner(ctx);

  await stakingRouter
    .connect(managerSigner)
    .updateStakingModule(
      moduleId,
      stakeShareLimit,
      BigIntMath.min(
        stakeShareLimit + (module.priorityExitShareThreshold - module.stakeShareLimit),
        TOTAL_BASIS_POINTS,
      ),
      module.stakingModuleFee,
      module.treasuryFee,
      module.maxDepositsPerBlock,
      module.minDepositBlockDistance,
    );
};

export const ensureStakeLimit = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;

  const stakeLimitInfo = await lido.getStakeLimitFullInfo();
  if (!stakeLimitInfo.isStakingLimitSet) {
    const maxStakeLimit = ether("150000");
    const stakeLimitIncreasePerBlock = ether("20"); // this is an arbitrary value

    log.debug("Setting staking limit", {
      "Max stake limit": ethers.formatEther(maxStakeLimit),
      "Stake limit increase per block": ethers.formatEther(stakeLimitIncreasePerBlock),
    });

    const agentSigner = await ctx.getSigner("agent");
    await lido.connect(agentSigner).setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);

    log.success("Staking limit set");
  }
};

export const removeStakingLimit = async (ctx: ProtocolContext) => {
  const { lido, acl } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");
  const role = await lido.STAKING_CONTROL_ROLE();
  const agentAddress = await agentSigner.getAddress();
  await acl.connect(agentSigner).grantPermission(agentAddress, lido.address, role);
  await lido.connect(agentSigner).removeStakingLimit();
  await acl.connect(agentSigner).revokePermission(agentAddress, lido.address, role);
};

export const setStakingLimit = async (
  ctx: ProtocolContext,
  maxStakeLimit: bigint,
  stakeLimitIncreasePerBlock: bigint,
) => {
  const { lido, acl } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");
  const role = await lido.STAKING_CONTROL_ROLE();
  const agentAddress = await agentSigner.getAddress();
  await acl.connect(agentSigner).grantPermission(agentAddress, lido.address, role);
  await lido.connect(agentSigner).setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);
  await acl.connect(agentSigner).revokePermission(agentAddress, lido.address, role);
};

export const ensureCanDeposit = async (ctx: ProtocolContext) => {
  const { accountingOracle } = ctx.contracts;
  const { extraDataSubmitted } = await accountingOracle.getProcessingState();
  const getLastProcessingRefSlot = await accountingOracle.getLastProcessingRefSlot();

  if (!extraDataSubmitted && getLastProcessingRefSlot != 0n) {
    // send dummy report to shift last processing ref slot and unlock deposits
    await report(ctx, { skipWithdrawals: true });
  }
};

const depositValidatorsViaRouter = async (ctx: ProtocolContext, moduleId: bigint, depositsCount: bigint) => {
  const { depositSecurityModule, stakingRouter } = ctx.contracts;

  const managerSigner = await getStakingModuleManagerSigner(ctx);
  if (!managerSigner) {
    throw new Error("staking module manager signer is required for deposit setup");
  }

  const moduleConfig = await stakingRouter.getStakingModule(moduleId);
  const shouldRestoreMaxDepositsPerBlock = moduleConfig.maxDepositsPerBlock > depositsCount;

  if (shouldRestoreMaxDepositsPerBlock) {
    await stakingRouter
      .connect(managerSigner)
      .updateStakingModule(
        moduleId,
        moduleConfig.stakeShareLimit,
        moduleConfig.priorityExitShareThreshold,
        moduleConfig.stakingModuleFee,
        moduleConfig.treasuryFee,
        depositsCount,
        moduleConfig.minDepositBlockDistance,
      );
  }

  try {
    const dsmSigner = await impersonate(await depositSecurityModule.getAddress(), ether("1"));
    await stakingRouter.connect(dsmSigner).deposit(moduleId, ZERO_HASH);
  } finally {
    if (shouldRestoreMaxDepositsPerBlock) {
      await stakingRouter
        .connect(managerSigner)
        .updateStakingModule(
          moduleId,
          moduleConfig.stakeShareLimit,
          moduleConfig.priorityExitShareThreshold,
          moduleConfig.stakingModuleFee,
          moduleConfig.treasuryFee,
          moduleConfig.maxDepositsPerBlock,
          moduleConfig.minDepositBlockDistance,
        );
    }
  }
};

export const depositValidatorsWithoutReport = async (ctx: ProtocolContext, moduleId: bigint, depositsCount: bigint) => {
  const { lido, withdrawalQueue } = ctx.contracts;

  const ethToDeposit = depositsCount * DEPOSIT_SIZE;
  let depositableEther = await lido.getDepositableEther();

  if (depositableEther < ethToDeposit) {
    const submitValue = (await withdrawalQueue.unfinalizedStETH()) + ethToDeposit - depositableEther + ether("1");
    const ethHolder = await impersonate(certainAddress("provision:eth:whale"), submitValue + ether("1"));
    await lido.connect(ethHolder).submit(ZeroAddress, { value: submitValue });
  }

  depositableEther = await lido.getDepositableEther();
  if (depositableEther < ethToDeposit) {
    throw new Error(`Not enough depositable ether for staking module ${moduleId}`);
  }

  await ensureCanDeposit(ctx);
  await setModuleStakeShareLimit(ctx, moduleId, TOTAL_BASIS_POINTS);

  const { validatorsBalanceGwei: validatorsBefore } = await getStakingModuleBalances(ctx, moduleId);
  const depositedBefore = (await lido.getBalanceStats()).depositedSinceLastReport;

  await depositValidatorsViaRouter(ctx, moduleId, depositsCount);

  const { validatorsBalanceGwei: validatorsAfter } = await getStakingModuleBalances(ctx, moduleId);
  const { depositedSinceLastReport } = await lido.getBalanceStats();

  if (depositedSinceLastReport - depositedBefore !== ethToDeposit) {
    throw new Error(`Deposited ${depositedSinceLastReport - depositedBefore} wei, expected ${ethToDeposit}`);
  }

  if (validatorsAfter !== validatorsBefore) {
    throw new Error(`Validators balance changed before report: ${validatorsAfter} != ${validatorsBefore}`);
  }
};

export const getCurrentModuleAccountingReportParams = async (
  ctx: ProtocolContext,
): Promise<ModuleAccountingReportParams> => {
  return buildModuleAccountingReportParams(ctx);
};

export const seedProtocolPendingBaseline = async (
  ctx: ProtocolContext,
  moduleId: bigint,
  depositsCount: bigint = 1n,
) => {
  await depositValidatorsWithoutReport(ctx, moduleId, depositsCount);

  const { depositedSinceLastReport } = await ctx.contracts.lido.getBalanceStats();
  const { data } = await report(ctx, {
    clDiff: depositedSinceLastReport,
    dryRun: true,
    excludeVaultsBalances: true,
    skipWithdrawals: true,
    ...(await buildModuleAccountingReportParams(ctx)),
  });

  const pendingBaselineGwei = depositedSinceLastReport / ONE_GWEI;
  return submitReportDataWithConsensusAndEmptyExtraData(ctx, {
    ...data,
    clValidatorsBalanceGwei: BigInt(data.clValidatorsBalanceGwei) - pendingBaselineGwei,
    clPendingBalanceGwei: pendingBaselineGwei,
  });
};

export const depositAndReportValidators = async (ctx: ProtocolContext, moduleId: bigint, depositsCount: bigint) => {
  const { lido, withdrawalQueue, stakingRouter } = ctx.contracts;

  const ethToDeposit = depositsCount * DEPOSIT_SIZE;
  const submitValue = (await withdrawalQueue.unfinalizedStETH()) + ethToDeposit;
  const ethHolder = await impersonate(certainAddress("provision:eth:whale"), submitValue + ether("1"));
  const managerSigner = await getStakingModuleManagerSigner(ctx);

  await lido.connect(ethHolder).submit(ZeroAddress, { value: submitValue });

  const depositableEther = await lido.getDepositableEther();
  if (depositableEther < ethToDeposit) {
    throw new Error(`Not enough depositable ether for staking module ${moduleId}`);
  }

  const isMaxDepositsCountNotEnough = async () => {
    const maxDepositsCount = await stakingRouter.getStakingModuleMaxDepositsCount(moduleId, ethToDeposit);
    return maxDepositsCount < depositsCount;
  };

  const otherModulesStatusesBefore = await getStakingModuleStatuses(ctx);
  delete otherModulesStatusesBefore[Number(moduleId)];

  // Pause other modules if max deposits count is not enough
  if (await isMaxDepositsCountNotEnough()) {
    for (const mId of Object.keys(otherModulesStatusesBefore)) {
      const currentStatus = await stakingRouter.getStakingModuleStatus(mId);
      if (currentStatus === BigInt(StakingModuleStatus.DepositsPaused)) continue;
      await stakingRouter
        .connect(managerSigner)
        .setStakingModuleStatus(Number(mId), StakingModuleStatus.DepositsPaused);
    }
  }

  if (await isMaxDepositsCountNotEnough()) {
    throw new Error(`Not enough max deposits count for staking module ${moduleId}`);
  }

  const getTotalDepositedValidators = async () => {
    const moduleDigests = await stakingRouter.getAllStakingModuleDigests();
    return moduleDigests.reduce((sum, digest) => sum + digest.summary.totalDepositedValidators, 0n);
  };

  const numDepositedBefore = await getTotalDepositedValidators();

  await ensureCanDeposit(ctx);

  // Deposit validators via StakingRouter (DSM calls SR which pulls ETH from Lido)
  await depositValidatorsViaRouter(ctx, moduleId, depositsCount);

  const numDepositedAfter = await getTotalDepositedValidators();

  if (numDepositedAfter !== numDepositedBefore + depositsCount) {
    throw new Error(`Deposited ${numDepositedAfter} validators, expected ${numDepositedBefore + depositsCount}`);
  }

  // Restore staking module statuses
  for (const [mId, originalStatus] of Object.entries(otherModulesStatusesBefore)) {
    const currentStatus = await stakingRouter.getStakingModuleStatus(mId);
    if (currentStatus === BigInt(originalStatus)) continue;
    await stakingRouter.connect(managerSigner).setStakingModuleStatus(mId, originalStatus);
  }

  const before = await lido.getBalanceStats();

  log.debug("Validators on beacon chain before provisioning", {
    "Module ID to deposit": moduleId,
    "Deposited": before.depositedSinceLastReport,
    "Active": before.clValidatorsBalanceAtLastReport,
    "Pending": before.clPendingBalanceAtLastReport,
  });

  // Add new validators to beacon chain
  const validatorsDeltaGweiByModule = new Map<bigint, bigint>([[moduleId, ethToDeposit / ONE_GWEI]]);
  await report(ctx, {
    clDiff: ethToDeposit,
    clAppearedValidators: depositsCount,
    skipWithdrawals: true,
    ...(await buildModuleAccountingReportParams(ctx, { validatorsDeltaGweiByModule })),
  });

  const after = await lido.getBalanceStats();

  log.debug("Validators on beacon chain after depositing", {
    "Module ID deposited": moduleId,
    "Deposited": after.depositedSinceLastReport,
    "Active": after.clValidatorsBalanceAtLastReport,
    "Pending": after.clPendingBalanceAtLastReport,
  });
};
