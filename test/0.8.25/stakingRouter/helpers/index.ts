import { expect } from "chai";
import { randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  StakingModule__MockForStakingRouter,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";

import { wcTypeMaxEB } from "lib";
import { ONE_GWEI, StakingModuleStatus, TOTAL_BASIS_POINTS, WithdrawalCredentialsType } from "lib/constants";

export const DEFAULT_CONFIG: ModuleConfig = {
  stakeShareLimit: TOTAL_BASIS_POINTS,
  priorityExitShareThreshold: TOTAL_BASIS_POINTS,
  moduleFee: 5_00n,
  treasuryFee: 5_00n,
  maxDepositsPerBlock: 150n,
  minDepositBlockDistance: 25n,
  withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
};
export const DEFAULT_MEB = wcTypeMaxEB(DEFAULT_CONFIG.withdrawalCredentialsType);

type SetupModuleResult<T extends WithdrawalCredentialsType> = T extends WithdrawalCredentialsType.WC0x02
  ? [StakingModuleV2__MockForStakingRouter, bigint]
  : T extends WithdrawalCredentialsType.WC0x01
    ? [StakingModule__MockForStakingRouter, bigint]
    : [StakingModule__MockForStakingRouter | StakingModuleV2__MockForStakingRouter, bigint];

export async function setupModule<T extends WithdrawalCredentialsType>(
  ctx: CtxConfig,
  cfg: ModuleConfig & { withdrawalCredentialsType: T },
): Promise<SetupModuleResult<T>>;

export async function setupModule(
  { stakingRouter, admin, deployer }: CtxConfig,
  {
    stakeShareLimit,
    priorityExitShareThreshold,
    moduleFee,
    treasuryFee,
    maxDepositsPerBlock,
    minDepositBlockDistance,
    exited = 0n,
    deposited = 0n,
    depositable = 0n,
    status = StakingModuleStatus.Active,
    withdrawalCredentialsType = WithdrawalCredentialsType.WC0x01,
    validatorsBalanceGwei = 0n,
    totalModuleStake = 0n,
  }: ModuleConfig,
): Promise<[StakingModule__MockForStakingRouter | StakingModuleV2__MockForStakingRouter, bigint]> {
  const modulesCount = await stakingRouter.getStakingModulesCount();
  const moduleId = modulesCount + 1n;

  const stakingModuleConfig = {
    stakeShareLimit,
    priorityExitShareThreshold,
    stakingModuleFee: moduleFee,
    treasuryFee,
    maxDepositsPerBlock,
    minDepositBlockDistance,
    withdrawalCredentialsType,
  };

  const initializeModule = async (
    module: StakingModule__MockForStakingRouter | StakingModuleV2__MockForStakingRouter,
  ) => {
    await stakingRouter
      .connect(admin)
      .addStakingModule(randomBytes(8).toString(), await module.getAddress(), stakingModuleConfig);

    expect(await stakingRouter.getStakingModulesCount()).to.equal(modulesCount + 1n);

    await module.mock__getStakingModuleSummary(exited, deposited, depositable);
    if (validatorsBalanceGwei == 0n && deposited > 0n) {
      validatorsBalanceGwei = (deposited * wcTypeMaxEB(withdrawalCredentialsType)) / ONE_GWEI;
    }
    await stakingRouter.testing_setStakingModuleAccounting(moduleId, validatorsBalanceGwei, exited);

    if (status != StakingModuleStatus.Active) {
      await stakingRouter.setStakingModuleStatus(moduleId, status);
    }
  };

  if (withdrawalCredentialsType === WithdrawalCredentialsType.WC0x02) {
    const module = await ethers.deployContract("StakingModuleV2__MockForStakingRouter", deployer);
    await initializeModule(module);

    if (totalModuleStake == 0n && deposited > 0n) {
      totalModuleStake = deposited * wcTypeMaxEB(WithdrawalCredentialsType.WC0x01);
    }
    await module.mock__getTotalModuleStake(totalModuleStake);

    return [module, moduleId];
  }

  const module = await ethers.deployContract("StakingModule__MockForStakingRouter", deployer);
  await initializeModule(module);

  return [module, moduleId];
}

export interface CtxConfig {
  deployer: HardhatEthersSigner;
  admin: HardhatEthersSigner;
  stakingRouter: StakingRouter__Harness;
}

export interface ModuleConfig {
  stakeShareLimit: bigint;
  priorityExitShareThreshold: bigint;
  moduleFee: bigint;
  treasuryFee: bigint;
  maxDepositsPerBlock: bigint;
  minDepositBlockDistance: bigint;
  withdrawalCredentialsType: WithdrawalCredentialsType;
  exited?: bigint;
  deposited?: bigint;
  depositable?: bigint;
  status?: StakingModuleStatus;
  validatorsBalanceGwei?: bigint;
  totalModuleStake?: bigint;
}
