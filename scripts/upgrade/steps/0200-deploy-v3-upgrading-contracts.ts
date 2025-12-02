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
  const oldLocatorImplementation = await locatorProxy.proxy__getImplementation();
  const accountingOracle = await loadContract<IOssifiableProxy>(
    "IOssifiableProxy",
    state[Sk.accountingOracle].proxy.address,
  );

  const kernel = await loadContract<IAragonKernel>("IAragonKernel", getAddress(Sk.aragonKernel, state));
  const appBasesNamespace = await kernel.APP_BASES_NAMESPACE();
  const oldLidoImpl = await kernel.getApp(appBasesNamespace, state[Sk.appLido].aragonApp.id);

  const addressesParams = [
    // Old implementations
    oldLocatorImplementation,
    oldLidoImpl,
    await accountingOracle.proxy__getImplementation(),
    getAddress(Sk.tokenRebaseNotifier, state),

    // New implementations
    state[Sk.lidoLocator].implementation.address,
    state[Sk.appLido].implementation.address,
    state[Sk.accountingOracle].implementation.address,
    getAddress(Sk.tokenRebaseNotifierV3, state),

    // New fancy proxy and blueprint contracts
    state[Sk.stakingVaultBeacon].address,
    state[Sk.stakingVaultImplementation].address,
    state[Sk.dashboardImpl].address,
    getAddress(Sk.gateSealV3, state),

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
    parameters.easyTrack.VaultsAdapter,

    // EasyTrack new factories
    parameters.easyTrack.newFactories.AlterTiersInOperatorGrid,
    parameters.easyTrack.newFactories.RegisterGroupsInOperatorGrid,
    parameters.easyTrack.newFactories.RegisterTiersInOperatorGrid,
    parameters.easyTrack.newFactories.UpdateGroupsShareLimitInOperatorGrid,
    parameters.easyTrack.newFactories.SetJailStatusInOperatorGrid,
    parameters.easyTrack.newFactories.UpdateVaultsFeesInOperatorGrid,
    parameters.easyTrack.newFactories.ForceValidatorExitsInVaultHub,
    parameters.easyTrack.newFactories.SocializeBadDebtInVaultHub,
  ];

  const template = await deployWithoutProxy(Sk.v3Template, "V3Template", deployer, [
    addressesParams,
    parameters.v3VoteScript.expiryTimestamp,
    parameters.v3VoteScript.initialMaxExternalRatioBP,
  ]);

  await deployWithoutProxy(Sk.v3VoteScript, "V3VoteScript", deployer, [
    [
      template.address,
      parameters.v3VoteScript.timeConstraintsContract,
      parameters.v3VoteScript.odcSlashingReserveWeRightShiftEpochs,
      parameters.v3VoteScript.odcSlashingReserveWeLeftShiftEpochs,
    ],
  ]);
}
