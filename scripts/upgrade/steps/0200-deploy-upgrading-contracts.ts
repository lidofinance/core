import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { IAragonKernel, IOssifiableProxy, OssifiableProxy__factory } from "typechain-types";

import { loadContract } from "lib/contract";
import { deployWithoutProxy } from "lib/deploy";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState();
  const parameters = readUpgradeParameters();

  const locatorProxy = OssifiableProxy__factory.connect(getAddress(Sk.lidoLocator, state), deployerSigner);
  const oldLocatorImpl = await locatorProxy.proxy__getImplementation();

  const kernel = await loadContract<IAragonKernel>("IAragonKernel", getAddress(Sk.aragonKernel, state));
  const appBasesNamespace = await kernel.APP_BASES_NAMESPACE();
  const oldLidoImpl = await kernel.getApp(appBasesNamespace, state[Sk.appLido].aragonApp.id);


  // const accountingOracleProxy = await loadContract<IOssifiableProxy>(
  //   "IOssifiableProxy",
  //   state[Sk.accountingOracle].proxy.address,
  // );
  const accountingOracleProxy = OssifiableProxy__factory.connect(getAddress(Sk.accountingOracle, state), deployerSigner);
  const oldAccountingOracleImpl = await accountingOracleProxy.proxy__getImplementation();
  const stakingRouterProxy = OssifiableProxy__factory.connect(getAddress(Sk.stakingRouter, state), deployerSigner);
  const oldStakingRouterImpl = await stakingRouterProxy.proxy__getImplementation();
  // const withdrawalVaultProxy = OssifiableProxy__factory.connect(getAddress(Sk.withdrawalVault, state), deployerSigner);

  //  struct UpgradeParameters {




  //       // todo csm deps?
  //       address identifiedCommunityStakersGateManager;
  //       address gateSeal;
  //       address gateSealV3;
  //       address generalDelayedPenaltyReporter;
  //       uint256 hashConsensusInitialEpoch;

  //       // Upgrade config for CSM/CMv2
  //       ConfigInput_CSM csm;
  //       ConfigInput_CMv2 cmv2;
    // }
  const upgradeParams = [
    // Old implementations
    oldLocatorImpl,
    oldLidoImpl,
    oldAccountingOracleImpl,
    oldStakingRouterImpl,

    // New implementations
    state[Sk.lidoLocator].implementation.address,
    state[Sk.appLido].implementation.address,
    state[Sk.accountingOracle].implementation.address,
    state[Sk.stakingRouter].implementation.address,

    // New fancy proxy and blueprint contracts
    state[Sk.topUpGateway].address,
    state[Sk.consolidationGateway].address,

    // Existing proxies and contracts
    getAddress(Sk.aragonKernel, state),
    state[Sk.appLido].aragonApp.id,
    getAddress(Sk.appAgent, state),
    getAddress(Sk.lidoLocator, state),
    getAddress(Sk.appVoting, state),
    getAddress(Sk.dgDualGovernance, state),
    getAddress(Sk.aragonAcl, state),
    getAddress(Sk.resealManager, state),

    // EasyTrack addresses
    getAddress(Sk.easyTrack, state),
    getAddress(Sk.easyTrackEVMScriptExecutor, state),

    // EasyTrack new factories
    parameters.easyTrack.newFactories.UpdateStakingModuleShareLimits,
  ];

  const template = await deployWithoutProxy(Sk.upgradeTemplate, "UpgradeTemplate", deployer, [
    upgradeParams,
    parameters.upgradeVoteScript.expiryTimestamp
  ]);

  await deployWithoutProxy(Sk.upgradeVoteScript, "UpgradeVoteScript", deployer, [
    [template.address, parameters.upgradeVoteScript.timeConstraintsContract],
  ]);
}
