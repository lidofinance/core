import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  IAragonKernel,
  IWithdrawalsManagerProxy__factory,
  LidoLocator,
  OssifiableProxy__factory,
} from "typechain-types";

import { loadContract } from "lib/contract";
import { deployWithoutProxy } from "lib/deploy";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = await ethers.provider.getSigner();
  const state = readNetworkState();
  const parameters = readUpgradeParameters();

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locatorProxy = OssifiableProxy__factory.connect(locatorAddress, deployer);
  const oldLocatorImpl = await locatorProxy.proxy__getImplementation();
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

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

  const upgradeParams = {
    locator: locatorAddress,
    agent: getAddress(Sk.appAgent, state),
    voting: getAddress(Sk.appVoting, state),
    dualGovernance: getAddress(Sk.dgDualGovernance, state),
    resealManager: getAddress(Sk.resealManager, state),
    easyTrack: getAddress(Sk.easyTrack, state),

    coreUpgrade: {
      oldLocatorImpl,
      oldLidoImpl,
      oldAccountingImpl: await accountingProxy.proxy__getImplementation(),
      oldAccountingOracleImpl: await accountingOracleProxy.proxy__getImplementation(),
      oldStakingRouterImpl: await stakingRouterProxy.proxy__getImplementation(),
      oldWithdrawalVaultImpl: await withdrawalVaultProxy.implementation(),
      oldValidatorsExitBusOracleImpl: await validatorsExitBusOracleProxy.proxy__getImplementation(),
      oldOracleReportSanityChecker: await locator.oracleReportSanityChecker(),
      oldDepositSecurityModule: await locator.depositSecurityModule(),

      newLocatorImpl: state[Sk.lidoLocator].implementation.address,
      newLidoImpl: state[Sk.appLido].implementation.address,
      newAccountingImpl: state[Sk.accounting].implementation.address,
      newAccountingOracleImpl: state[Sk.accountingOracle].implementation.address,
      newStakingRouterImpl: state[Sk.stakingRouter].implementation.address,
      newWithdrawalVaultImpl: state[Sk.withdrawalVault].implementation.address,
      newValidatorsExitBusOracleImpl: state[Sk.validatorsExitBusOracle].implementation.address,
      newOracleReportSanityChecker: getAddress(Sk.oracleReportSanityChecker, state),
      newDepositSecurityModule: getAddress(Sk.depositSecurityModule, state),
      consolidationBusImpl: state[Sk.consolidationBus].implementation.address,
      consolidationMigratorImpl: state[Sk.consolidationMigrator].implementation.address,

      // TopUp GW
      topUpGatewayImpl: state[Sk.topUpGateway].implementation.address,
      topUpGateway: getAddress(Sk.topUpGateway, state),
      topUpGatewayDepositor: parameters.topUpGateway.depositor,

      // Consolidation
      consolidationBus: getAddress(Sk.consolidationBus, state),

      consolidationGatewayGateSeal: getAddress(Sk.gateSealConsolidationGW, state),

      consolidationMigrator: getAddress(Sk.consolidationMigrator, state),
      curatedModuleCommittee: parameters.consolidationMigrator.committee,

      lidoDepositsReserveTarget: parameters.lido.lidoDepositsReserveTarget,

      // easy tracks
      etfUpdateStakingModuleShareLimits: parameters.easyTrack.newFactories.UpdateStakingModuleShareLimits,
      etfAllowConsolidationPair: parameters.easyTrack.newFactories.AllowConsolidationPair,
    },
    csmUpgrade: parameters.csmUpgrade,
    curatedModule: parameters.curatedModule,
  };

  const template = await deployWithoutProxy(Sk.upgradeTemplate, "UpgradeTemplate", deployer.address, [
    upgradeParams,
    parameters.upgradeVoteScript.expiryTimestamp,
  ]);

  await deployWithoutProxy(Sk.upgradeVoteScript, "UpgradeVoteScript", deployer.address, [
    [template.address, parameters.upgradeVoteScript.timeConstraintsContract],
  ]);
}
