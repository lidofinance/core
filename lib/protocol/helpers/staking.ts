import { ethers, ZeroAddress } from "ethers";

import { BigIntMath, certainAddress, ether, impersonate, log } from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";

import { ZERO_HASH } from "test/deploy";

import { ProtocolContext } from "../types";

import { report } from "./accounting";

const DEPOSIT_SIZE = ether("32");

export const unpauseStaking = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;
  if (await lido.isStakingPaused()) {
    const agentSigner = await ctx.getSigner("agent");
    await lido.connect(agentSigner).resume();

    log.success("Staking contract unpaused");
  }
};

export enum StakingModuleStatus {
  Active = 0,
  DepositsPaused = 1,
  Stopped = 2,
}

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

export const depositAndReportValidators = async (ctx: ProtocolContext, moduleId: bigint, depositsCount: bigint) => {
  const { lido, depositSecurityModule, withdrawalQueue, stakingRouter } = ctx.contracts;

  const ethToDeposit = depositsCount * DEPOSIT_SIZE;
  const submitValue = (await withdrawalQueue.unfinalizedStETH()) + ethToDeposit;
  const ethHolder = await impersonate(certainAddress("provision:eth:whale"), submitValue + ether("1"));
  const dsmSigner = await impersonate(depositSecurityModule.address, ether("100000"));
  const managerSigner = await getStakingModuleManagerSigner(ctx);

  await lido.connect(ethHolder).submit(ZeroAddress, { value: submitValue });

  const depositableEther = await lido.getDepositableEther();
  if (depositableEther < ethToDeposit) {
    throw new Error(`Not enough depositable ether for staking module ${moduleId}`);
  }

  const isMaxDepositsCountNotEnough = async () => {
    const maxDepositsCount = await stakingRouter.getStakingModuleMaxDepositsCount(moduleId, depositableEther);
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

  const numDepositedBefore = (await lido.getBeaconStat()).depositedValidators;

  // Deposit validators
  await lido.connect(dsmSigner).deposit(depositsCount, moduleId, ZERO_HASH);

  const numDepositedAfter = (await lido.getBeaconStat()).depositedValidators;

  if (numDepositedAfter !== numDepositedBefore + depositsCount) {
    throw new Error(`Deposited ${numDepositedAfter} validators, expected ${numDepositedBefore + depositsCount}`);
  }

  // Restore staking module statuses
  for (const [mId, originalStatus] of Object.entries(otherModulesStatusesBefore)) {
    const currentStatus = await stakingRouter.getStakingModuleStatus(mId);
    if (currentStatus === BigInt(originalStatus)) continue;
    await stakingRouter.connect(managerSigner).setStakingModuleStatus(mId, originalStatus);
  }

  const before = await lido.getBeaconStat();

  log.debug("Validators on beacon chain before provisioning", {
    "Module ID to deposit": moduleId,
    "Deposited": before.depositedValidators,
    "Total": before.beaconValidators,
    "Balance": before.beaconBalance,
  });

  // Add new validators to beacon chain
  await report(ctx, {
    clDiff: ethToDeposit,
    clAppearedValidators: depositsCount,
    skipWithdrawals: true,
  });

  const after = await lido.getBeaconStat();

  log.debug("Validators on beacon chain after depositing", {
    "Module ID deposited": moduleId,
    "Deposited": after.depositedValidators,
    "Total": after.beaconValidators,
    "Balance": after.beaconBalance,
  });
};
