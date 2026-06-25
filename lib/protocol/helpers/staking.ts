import { ethers, ZeroAddress } from "ethers";

import {
  BigIntMath,
  certainAddress,
  ether,
  impersonate,
  log,
  ONE_GWEI,
  StakingModuleStatus,
  toGwei,
  TOTAL_BASIS_POINTS,
} from "lib";

import { ProtocolContext } from "../types";

import {
  adjustReportModuleBalances,
  ensureFirstPostMigrationReport,
  normalizeWithdrawalVaultBaseline,
  report,
  submitReportDataWithConsensusAndEmptyExtraData,
} from "./accounting";
import { norSdvtSetOperatorStakingLimit } from "./nor-sdvt";
import { NOR_MODULE_ID, SDVT_MODULE_ID } from "./staking-module";

const DEPOSIT_SIZE = ether("32");

export type StakingModuleBalances = {
  validatorsBalanceGwei: bigint;
};

export type ModuleAccountingReportParams = {
  stakingModuleIdsWithUpdatedBalance: bigint[];
  validatorBalancesGweiByStakingModule: bigint[];
};

export type BufferedDepositResult = {
  moduleId: bigint;
  consumed: bigint;
  depositsCount: bigint;
  pendingGweiDelta: bigint;
};

export const unpauseStaking = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;
  if (await lido.isStakingPaused()) {
    const agentSigner = await ctx.getSigner("agent");
    await lido.connect(agentSigner).resume();

    log.success("Staking contract unpaused");
  }
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

export const buildModuleAccountingReportParams = async (
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

const depositValidatorsViaRouter = async (ctx: ProtocolContext, moduleId: bigint) => {
  const { depositSecurityModule, stakingRouter } = ctx.contracts;

  const dsmSigner = await impersonate(await depositSecurityModule.getAddress(), ether("1"));
  await stakingRouter.connect(dsmSigner).deposit(moduleId, "0x");
};

const getTotalDepositedValidators = async (ctx: ProtocolContext) => {
  const moduleDigests = await ctx.contracts.stakingRouter.getAllStakingModuleDigests();
  return moduleDigests.reduce((sum, digest) => sum + digest.summary.totalDepositedValidators, 0n);
};

const prepareStakingModuleForTestDeposit = async (ctx: ProtocolContext, moduleId: bigint, depositsCount: bigint) => {
  const { lido, stakingRouter } = ctx.contracts;
  const managerSigner = await getStakingModuleManagerSigner(ctx);
  if (!managerSigner) {
    throw new Error("staking module manager signer is required for deposit setup");
  }

  const ethToDeposit = depositsCount * DEPOSIT_SIZE;
  const depositableEther = await lido.getDepositableEther();
  if (depositableEther < ethToDeposit) {
    throw new Error(`Not enough depositable ether: ${depositableEther}, expected at least ${ethToDeposit}`);
  }

  const moduleIds = await stakingRouter.getStakingModuleIds();
  const moduleIndex = moduleIds.findIndex((id) => id === moduleId);
  if (moduleIndex === -1) {
    throw new Error(`Staking module ${moduleId} is not registered`);
  }

  await ensureOperatorsHaveAvailableKeys(ctx, [moduleId], depositsCount);

  for (const otherModuleId of moduleIds) {
    if (otherModuleId === moduleId) continue;

    const currentStatus = await stakingRouter.getStakingModuleStatus(otherModuleId);
    if (currentStatus === BigInt(StakingModuleStatus.DepositsPaused)) continue;

    await stakingRouter
      .connect(managerSigner)
      .setStakingModuleStatus(otherModuleId, StakingModuleStatus.DepositsPaused);
  }

  const moduleStatus = await stakingRouter.getStakingModuleStatus(moduleId);
  if (moduleStatus !== BigInt(StakingModuleStatus.Active)) {
    await stakingRouter.connect(managerSigner).setStakingModuleStatus(moduleId, StakingModuleStatus.Active);
  }

  const moduleConfig = await stakingRouter.getStakingModule(moduleId);
  if (
    moduleConfig.stakeShareLimit !== TOTAL_BASIS_POINTS ||
    moduleConfig.priorityExitShareThreshold !== TOTAL_BASIS_POINTS ||
    moduleConfig.maxDepositsPerBlock !== depositsCount
  ) {
    await stakingRouter
      .connect(managerSigner)
      .updateStakingModule(
        moduleId,
        TOTAL_BASIS_POINTS,
        TOTAL_BASIS_POINTS,
        moduleConfig.stakingModuleFee,
        moduleConfig.treasuryFee,
        depositsCount,
        moduleConfig.minDepositBlockDistance,
      );
  }

  const { allocated } = await stakingRouter.getDepositAllocations(depositableEther, false);
  if ((allocated[moduleIndex] ?? 0n) < ethToDeposit) {
    throw new Error(`Not enough allocation for staking module ${moduleId} to deposit ${ethToDeposit}`);
  }
};

const getDefaultDepositModuleId = async (ctx: ProtocolContext) => {
  const moduleIds = await ctx.contracts.stakingRouter.getStakingModuleIds();
  if (!moduleIds.includes(NOR_MODULE_ID)) {
    throw new Error("NOR staking module is not registered; pass preferredModuleId explicitly");
  }

  return NOR_MODULE_ID;
};

const depositPreparedValidatorsFromBuffer = async (
  ctx: ProtocolContext,
  depositsCount: bigint,
  moduleId: bigint,
): Promise<BufferedDepositResult> => {
  const { lido } = ctx.contracts;
  const ethToDeposit = depositsCount * DEPOSIT_SIZE;

  await prepareStakingModuleForTestDeposit(ctx, moduleId, depositsCount);

  const bufferedBefore = await lido.getBufferedEther();
  const depositedBefore = (await lido.getBalanceStats()).depositedSinceLastReport;
  const validatorsBefore = await getTotalDepositedValidators(ctx);

  await depositValidatorsViaRouter(ctx, moduleId);

  const bufferedAfter = await lido.getBufferedEther();
  const depositedAfter = (await lido.getBalanceStats()).depositedSinceLastReport;
  const validatorsAfter = await getTotalDepositedValidators(ctx);
  const consumed = bufferedBefore - bufferedAfter;
  const depositedDelta = depositedAfter - depositedBefore;

  if (consumed !== ethToDeposit || depositedDelta !== ethToDeposit) {
    throw new Error(`Deposited ${depositedDelta} wei and consumed ${consumed} wei, expected ${ethToDeposit}`);
  }
  if (validatorsAfter !== validatorsBefore + depositsCount) {
    throw new Error(`Deposited ${validatorsAfter - validatorsBefore} validators, expected ${depositsCount}`);
  }

  return {
    moduleId,
    consumed,
    depositsCount,
    pendingGweiDelta: depositedDelta / ONE_GWEI,
  };
};

const getNorSdvtModule = (ctx: ProtocolContext, moduleId: bigint) => {
  if (moduleId === NOR_MODULE_ID) return ctx.contracts.nor;
  if (moduleId === SDVT_MODULE_ID) return ctx.contracts.sdvt;
  return undefined;
};

const ensureOperatorsHaveAvailableKeys = async (
  ctx: ProtocolContext,
  moduleIdsToCheck: bigint[],
  depositsCount: bigint,
) => {
  const modules: Array<{
    module: NonNullable<ReturnType<typeof getNorSdvtModule>>;
    operatorsCount: bigint;
  }> = [];
  const moduleIdsFilter = new Set(moduleIdsToCheck.map(String));

  for (const moduleId of await ctx.contracts.stakingRouter.getStakingModuleIds()) {
    if (!moduleIdsFilter.has(moduleId.toString())) continue;

    const module = getNorSdvtModule(ctx, moduleId);
    if (module === undefined) continue;

    const { depositableValidatorsCount } = await module.getStakingModuleSummary();
    if (depositableValidatorsCount >= depositsCount) continue;

    const operatorsCount = await module.getNodeOperatorsCount();
    modules.push({ module, operatorsCount });
  }

  for (const { module, operatorsCount } of modules) {
    for (let operatorId = 0n; operatorId < operatorsCount; operatorId++) {
      const { active, totalVettedValidators, totalAddedValidators } = await module.getNodeOperator(operatorId, true);
      if (!active) continue;
      if (totalVettedValidators < totalAddedValidators) {
        await norSdvtSetOperatorStakingLimit(ctx, module, {
          operatorId,
          limit: totalAddedValidators,
        });
      }
    }
  }
};

export const depositAllocatedValidatorsFromBuffer = async (
  ctx: ProtocolContext,
  depositsCount: bigint = 1n,
  preferredModuleId?: bigint,
): Promise<BufferedDepositResult> => {
  const moduleId = preferredModuleId ?? (await getDefaultDepositModuleId(ctx));
  return depositPreparedValidatorsFromBuffer(ctx, depositsCount, moduleId);
};

export const depositValidatorsWithoutReport = async (
  ctx: ProtocolContext,
  depositsCount: bigint,
  preferredModuleId?: bigint,
): Promise<Map<bigint, bigint>> => {
  const { lido, withdrawalQueue } = ctx.contracts;

  const ethToDeposit = depositsCount * DEPOSIT_SIZE;
  let depositableEther = await lido.getDepositableEther();
  let submitValue = ethToDeposit;

  if (depositableEther < ethToDeposit) {
    const bufferedEther = await lido.getBufferedEther();
    const unfinalizedStETH = await withdrawalQueue.unfinalizedStETH();
    submitValue += unfinalizedStETH - bufferedEther;
  } else {
    submitValue -= ether("0.001"); // ensure consume buffer
  }
  const ethHolder = await impersonate(certainAddress("provision:eth:whale"), submitValue + ether("1"));
  await lido.connect(ethHolder).submit(ZeroAddress, { value: submitValue });

  depositableEther = await lido.getDepositableEther();
  if (depositableEther < ethToDeposit) {
    throw new Error(`Not enough depositable ether`);
  }

  const depositedBefore = (await lido.getBalanceStats()).depositedSinceLastReport;

  const validatorsDeltaGweiByModule = new Map<bigint, bigint>();
  const moduleId = preferredModuleId ?? (await getDefaultDepositModuleId(ctx));
  const { pendingGweiDelta } = await depositPreparedValidatorsFromBuffer(ctx, depositsCount, moduleId);
  validatorsDeltaGweiByModule.set(moduleId, pendingGweiDelta);

  const { depositedSinceLastReport } = await lido.getBalanceStats();

  if (depositedSinceLastReport - depositedBefore !== ethToDeposit) {
    throw new Error(`Deposited ${depositedSinceLastReport - depositedBefore} wei, expected ${ethToDeposit}`);
  }

  return validatorsDeltaGweiByModule;
};

export const seedProtocolPendingBaseline = async (
  ctx: ProtocolContext,
  moduleId: bigint,
  depositsCount: bigint = 1n,
) => {
  // This helper snapshots new deposits as CL pending and intentionally reports
  // no vault rewards, so WVB history must be zeroed before the report.
  await ensureFirstPostMigrationReport(ctx);
  await normalizeWithdrawalVaultBaseline(ctx, 0n);
  await depositValidatorsWithoutReport(ctx, depositsCount, moduleId);
  const { depositedSinceLastReport } = await ctx.contracts.lido.getBalanceStats();

  const { data } = await report(ctx, {
    clDiff: depositedSinceLastReport,
    dryRun: true,
    reportElVault: false,
    reportWithdrawalsVault: false,
    skipWithdrawals: true,
    waitNextReportTime: true,
  });

  const pendingBaselineGwei = toGwei(depositedSinceLastReport);
  const clValidatorsBalanceGwei = BigInt(data.clValidatorsBalanceGwei) - pendingBaselineGwei;
  const moduleBalanceParams = adjustReportModuleBalances(
    await buildModuleAccountingReportParams(ctx),
    clValidatorsBalanceGwei,
  );
  const moduleBalancesSum = moduleBalanceParams.validatorBalancesGweiByStakingModule.reduce(
    (sum, balance) => sum + balance,
    0n,
  );
  if (moduleBalancesSum !== clValidatorsBalanceGwei) {
    throw new Error(`Module balances sum ${moduleBalancesSum} does not match CL validators ${clValidatorsBalanceGwei}`);
  }

  return submitReportDataWithConsensusAndEmptyExtraData(ctx, {
    ...data,
    clValidatorsBalanceGwei,
    clPendingBalanceGwei: pendingBaselineGwei,
    ...moduleBalanceParams,
  });
};

export const depositAndReportValidators = async (ctx: ProtocolContext, moduleId: bigint, depositsCount: bigint) => {
  const { lido, withdrawalQueue } = ctx.contracts;

  // Operator-provisioning reports should activate only the deposited validators.
  // Keep unrelated WVB/EL rewards out of this helper's report.
  await ensureFirstPostMigrationReport(ctx);
  await normalizeWithdrawalVaultBaseline(ctx, 0n);

  const ethToDeposit = depositsCount * DEPOSIT_SIZE;
  const submitValue = (await withdrawalQueue.unfinalizedStETH()) + ethToDeposit;
  const ethHolder = await impersonate(certainAddress("provision:eth:whale"), submitValue + ether("1"));

  await lido.connect(ethHolder).submit(ZeroAddress, { value: submitValue });

  const depositableEther = await lido.getDepositableEther();
  if (depositableEther < ethToDeposit) {
    throw new Error(`Not enough depositable ether for staking module ${moduleId}`);
  }

  await prepareStakingModuleForTestDeposit(ctx, moduleId, depositsCount);

  const numDepositedBefore = await getTotalDepositedValidators(ctx);

  // Deposit validators via StakingRouter (DSM calls SR which pulls ETH from Lido)
  await depositValidatorsViaRouter(ctx, moduleId);

  const numDepositedAfter = await getTotalDepositedValidators(ctx);

  if (numDepositedAfter !== numDepositedBefore + depositsCount) {
    throw new Error(`Deposited ${numDepositedAfter} validators, expected ${numDepositedBefore + depositsCount}`);
  }

  const before = await lido.getBalanceStats();

  log.debug("Validators on beacon chain before provisioning", {
    "Module ID to deposit": moduleId,
    "Deposited": before.depositedSinceLastReport,
    "Active": before.clValidatorsBalanceAtLastReport,
    "Pending": before.clPendingBalanceAtLastReport,
  });

  // Add new validators to beacon chain
  const validatorsDeltaGweiByModule = new Map<bigint, bigint>([[moduleId, toGwei(ethToDeposit)]]);
  const rawClDiff = before.depositedSinceLastReport;
  const postCLBalanceWei = before.clValidatorsBalanceAtLastReport + before.clPendingBalanceAtLastReport + rawClDiff;

  await report(ctx, {
    clDiff: rawClDiff,
    clAppearedValidators: depositsCount,
    reportElVault: false,
    reportWithdrawalsVault: false,
    skipWithdrawals: true,
    ...adjustReportModuleBalances(
      await buildModuleAccountingReportParams(ctx, { validatorsDeltaGweiByModule }),
      toGwei(postCLBalanceWei),
    ),
  });

  const after = await lido.getBalanceStats();

  log.debug("Validators on beacon chain after depositing", {
    "Module ID deposited": moduleId,
    "Deposited": after.depositedSinceLastReport,
    "Active": after.clValidatorsBalanceAtLastReport,
    "Pending": after.clPendingBalanceAtLastReport,
  });
};
