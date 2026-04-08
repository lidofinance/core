import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { IAragonKernel, LidoLocator, OssifiableProxy__factory } from "typechain-types";

import { loadContract } from "lib/contract";
import { deployWithoutProxy } from "lib/deploy";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState({ deployer });
  const parameters = readUpgradeParameters();

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locatorProxy = OssifiableProxy__factory.connect(locatorAddress, deployerSigner);
  const oldLocatorImpl = await locatorProxy.proxy__getImplementation();
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  const kernel = await loadContract<IAragonKernel>("IAragonKernel", getAddress(Sk.aragonKernel, state));
  const oldLidoImpl = await kernel.getApp(await kernel.APP_BASES_NAMESPACE(), state[Sk.appLido].aragonApp.id);

  const accountingOracleProxy = OssifiableProxy__factory.connect(
    getAddress(Sk.accountingOracle, state),
    deployerSigner,
  );
  const stakingRouterProxy = OssifiableProxy__factory.connect(getAddress(Sk.stakingRouter, state), deployerSigner);

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
      oldAccountingOracleImpl: await accountingOracleProxy.proxy__getImplementation(),
      oldStakingRouterImpl: await stakingRouterProxy.proxy__getImplementation(),
      oldOracleReportSanityChecker: await locator.oracleReportSanityChecker(),
      oldDepositSecurityModule: await locator.depositSecurityModule(),

      newLocatorImpl: state[Sk.lidoLocator].implementation.address,
      newLidoImpl: state[Sk.appLido].implementation.address,
      newAccountingOracleImpl: state[Sk.accountingOracle].implementation.address,
      newStakingRouterImpl: state[Sk.stakingRouter].implementation.address,
      newAccountingImpl: state[Sk.accounting].implementation.address,
      newWithdrawalVaultImpl: state[Sk.withdrawalVault].implementation.address,
      newOracleReportSanityChecker: getAddress(Sk.oracleReportSanityChecker, state),
      newDepositSecurityModule: await locator.depositSecurityModule(),

      // TopUp GW
      topUpGatewayImpl: state[Sk.topUpGateway].implementation.address,
      topUpDepositorBot: parameters.topUpGateway.depositor,

      // Consolidation
      consolidationGatewayImpl: getAddress(Sk.consolidationGateway, state),
      consolidationBus: getAddress(Sk.consolidationBus, state),
      consolidationBusExecutor: parameters.consolidationBus.executor,
      consolidationMigrator: getAddress(Sk.consolidationMigrator, state),
      consolidationGatewayGateSeal: parameters.consolidationGateway.gateSeal,
      // consolidationCommittee: parameters.easyTrack.trustedCaller,

      // TW
      twMaxExitRequestsLimit: parameters.triggerableWithdrawalsGateway.maxExitRequestsLimit,
      twExitsPerFrame: parameters.triggerableWithdrawalsGateway.exitsPerFrame,
      twFrameDurationInSec: parameters.triggerableWithdrawalsGateway.frameDurationInSec,

      // easy tracks
      etfUpdateStakingModuleShareLimits: parameters.easyTrack.newFactories.UpdateStakingModuleShareLimits,
      etfAllowConsolidationPair: parameters.easyTrack.newFactories.AllowConsolidationPair,
    },
    csmUpgrade: parameters.csmUpgrade,
    curatedModule: parameters.curatedModule,
  };

  const template = await deployWithoutProxy(Sk.upgradeTemplate, "UpgradeTemplate", deployer, [
    upgradeParams,
    parameters.upgradeVoteScript.expiryTimestamp,
  ]);

  await deployWithoutProxy(Sk.upgradeVoteScript, "UpgradeVoteScript", deployer, [
    [template.address, parameters.upgradeVoteScript.timeConstraintsContract],
  ]);
}
