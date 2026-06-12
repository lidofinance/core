import { ethers } from "hardhat";
import { checkArtifactDeployedAndLog, readUpgradeParameters } from "scripts/utils/upgrade";

import {
  IAragonKernel,
  IWithdrawalsManagerProxy__factory,
  OssifiableProxy__factory,
  UpgradeTemplate__factory,
} from "typechain-types";
import { UpgradeParametersStruct } from "typechain-types/contracts/upgrade/UpgradeConfig";

import {
  ConstructorArgs,
  deployWithoutProxy,
  getAddress,
  loadContract,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
} from "lib";

export async function skip(): Promise<boolean> {
  return await checkArtifactDeployedAndLog(Sk.upgradeTemplate);
}

export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = await ethers.provider.getSigner();

  await logScriptHeader("SRv3/CMv2 — Deploy UpgradeTemplate contract", deployer.address);

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locatorProxy = OssifiableProxy__factory.connect(locatorAddress, deployer);
  const oldLocatorImpl = await locatorProxy.proxy__getImplementation();

  const kernel = await loadContract<IAragonKernel>("IAragonKernel", getAddress(Sk.aragonKernel, state));
  const oldLidoImpl = await kernel.getApp(await kernel.APP_BASES_NAMESPACE(), state[Sk.appLido].aragonApp.id);

  const accountingProxy = OssifiableProxy__factory.connect(getAddress(Sk.accounting, state), deployer);
  const accountingOracleProxy = OssifiableProxy__factory.connect(getAddress(Sk.accountingOracle, state), deployer);
  const stakingRouterProxy = OssifiableProxy__factory.connect(getAddress(Sk.stakingRouter, state), deployer);
  const withdrawalVaultProxy = IWithdrawalsManagerProxy__factory.connect(
    getAddress(Sk.withdrawalVault, state),
    deployer,
  );
  const validatorsExitBusOracleProxy = OssifiableProxy__factory.connect(
    getAddress(Sk.validatorsExitBusOracle, state),
    deployer,
  );

  const upgradeParams: UpgradeParametersStruct = {
    locator: locatorAddress,
    agent: getAddress(Sk.appAgent, state),
    voting: getAddress(Sk.appVoting, state),
    dualGovernance: getAddress(Sk.dgDualGovernance, state),
    easyTrack: getAddress(Sk.easyTrack, state),
    circuitBreaker: getAddress(Sk.circuitBreaker, state),

    newFactories: parameters.easyTrack.newFactories,
    oldFactories: parameters.easyTrack.oldFactories,

    coreUpgrade: {
      oldLocatorImpl,
      oldLidoImpl,
      oldAccountingImpl: await accountingProxy.proxy__getImplementation(),
      oldAccountingOracleImpl: await accountingOracleProxy.proxy__getImplementation(),
      oldStakingRouterImpl: await stakingRouterProxy.proxy__getImplementation(),
      oldWithdrawalVaultImpl: await withdrawalVaultProxy.implementation(),
      oldValidatorsExitBusOracleImpl: await validatorsExitBusOracleProxy.proxy__getImplementation(),

      newLocatorImpl: state[Sk.lidoLocator].implementation.address,
      newLidoImpl: state[Sk.appLido].implementation.address,
      newAccountingImpl: state[Sk.accounting].implementation.address,
      newAccountingOracleImpl: state[Sk.accountingOracle].implementation.address,
      newStakingRouterImpl: state[Sk.stakingRouter].implementation.address,
      newWithdrawalVaultImpl: state[Sk.withdrawalVault].implementation.address,
      newValidatorsExitBusOracleImpl: state[Sk.validatorsExitBusOracle].implementation.address,
      consolidationBusImpl: state[Sk.consolidationBus].implementation.address,
      consolidationMigratorImpl: state[Sk.consolidationMigrator].implementation.address,

      // TopUp GW
      topUpGatewayImpl: state[Sk.topUpGateway].implementation.address,
      topUpGateway: getAddress(Sk.topUpGateway, state),
      topUpGatewayDepositor: parameters.topUpGateway.depositor!,

      // TW GW
      twMaxExitRequestsLimit: parameters.triggerableWithdrawalsGateway.maxExitRequestsLimit,
      twExitsPerFrame: parameters.triggerableWithdrawalsGateway.exitsPerFrame,
      twFrameDurationInSec: parameters.triggerableWithdrawalsGateway.frameDurationInSec,

      // Oracle configs
      aoConsensusVersion: parameters.accountingOracle.consensusVersion,
      veboMaxValidatorsPerReport: parameters.validatorsExitBusOracle.maxValidatorsPerReport,
      veboMaxExitBalanceEth: parameters.validatorsExitBusOracle.maxExitBalanceEth,
      veboBalancePerFrameEth: parameters.validatorsExitBusOracle.balancePerFrameEth,
      veboFrameDurationInSec: parameters.validatorsExitBusOracle.frameDurationInSec,
      veboConsensusVersion: parameters.validatorsExitBusOracle.consensusVersion,

      // Consolidation
      consolidationBus: getAddress(Sk.consolidationBus, state),

      consolidationMigrator: getAddress(Sk.consolidationMigrator, state),
      consolidationCommittee: parameters.consolidationMigrator.consolidationCommittee!,

      lidoDepositsReserveTarget: parameters.lido.depositsReserveTarget,

      // StakingRouter
      maxTopUpPerBlockGwei: parameters.stakingRouter.maxTopUpPerBlockGwei,
    },
    csmUpgrade: parameters.csmUpgrade,
    curatedModule: parameters.curatedModule,
  };

  const upgradeTemplateConstructorArgs: ConstructorArgs<UpgradeTemplate__factory> = [
    upgradeParams,
    parameters.upgradeVoteScript.expiryTimestamp,
  ];

  logStartReview();
  await logArgs("UpgradeTemplate", upgradeTemplateConstructorArgs);
  await logConfirmReview();

  await deployWithoutProxy(Sk.upgradeTemplate, "UpgradeTemplate", deployer.address, upgradeTemplateConstructorArgs);
}
