import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { IAragonAppRepo, IOssifiableProxy, OssifiableProxy__factory } from "typechain-types";
import { V3VoteScript } from "typechain-types";

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
  const lidoRepo = await loadContract<IAragonAppRepo>("IAragonAppRepo", state[Sk.aragonLidoAppRepo].proxy.address);
  const [, lidoImplementation] = await lidoRepo.getLatest();

  const addressesParams = [
    // Old implementations
    oldLocatorImplementation,
    lidoImplementation,
    await accountingOracle.proxy__getImplementation(),

    // New implementations
    state[Sk.lidoLocator].implementation.address,
    state[Sk.appLido].implementation.address,
    state[Sk.accountingOracle].implementation.address,

    // New fancy proxy and blueprint contracts
    state[Sk.stakingVaultBeacon].address,
    state[Sk.stakingVaultImplementation].address,
    state[Sk.dashboardImpl].address,
    getAddress(Sk.gateSealV3, state),

    // Existing proxies and contracts
    getAddress(Sk.aragonKernel, state),
    getAddress(Sk.appAgent, state),
    getAddress(Sk.aragonLidoAppRepo, state),
    getAddress(Sk.lidoLocator, state),
    getAddress(Sk.appVoting, state),
    getAddress(Sk.dgDualGovernance, state),
    getAddress(Sk.aragonAcl, state),

    // EasyTrack addresses
    getAddress(Sk.easyTrack, state),
    getAddress(Sk.vaultsAdapter, state),

    // EasyTrack new factories
    parameters.easyTrack.newFactories.AlterTiersInOperatorGrid,
    parameters.easyTrack.newFactories.RegisterGroupsInOperatorGrid,
    parameters.easyTrack.newFactories.RegisterTiersInOperatorGrid,
    parameters.easyTrack.newFactories.UpdateGroupsShareLimitInOperatorGrid,
    parameters.easyTrack.newFactories.SetJailStatusInOperatorGrid,
    parameters.easyTrack.newFactories.UpdateVaultsFeesInOperatorGrid,
    parameters.easyTrack.newFactories.ForceValidatorExitsInVaultHub,
    parameters.easyTrack.newFactories.SetLiabilitySharesTargetInVaultHub,
    parameters.easyTrack.newFactories.SocializeBadDebtInVaultHub,

    // Treasury transfer parameters
    parameters.v3VoteScript.finance,
    parameters.v3VoteScript.maticToken,
    parameters.v3VoteScript.lolMultisig,
    parameters.v3VoteScript.maticAmountWeiForTransfer,
    parameters.v3VoteScript.transferReference,
    parameters.v3VoteScript.easyTrackTrpRegistry,
  ];

  const template = await deployWithoutProxy(Sk.v3Template, "V3Template", deployer, [
    addressesParams,
    parameters.v3VoteScript.initialMaxExternalRatioBP,
    parameters.v3VoteScript.timeConstraints,
  ]);

  const voteScriptParams: V3VoteScript.ScriptParamsStruct = {
    upgradeTemplate: template.address,
    lidoAppId: state[Sk.appLido].aragonApp.id,
    stakingModuleId: parameters.v3VoteScript.stakingModuleId,
    stakeShareLimit: parameters.v3VoteScript.stakeShareLimit,
    trpLimitAfter: parameters.v3VoteScript.trpLimitAfter,
    trpPeriodDurationMonths: parameters.v3VoteScript.trpPeriodDurationMonths,
    odcSlashingReserveWeRightShiftEpochs: parameters.v3VoteScript.odcSlashingReserveWeRightShiftEpochs,
    odcSlashingReserveWeLeftShiftEpochs: parameters.v3VoteScript.odcSlashingReserveWeLeftShiftEpochs,
    finance: parameters.v3VoteScript.finance,
    maticToken: parameters.v3VoteScript.maticToken,
    lolMultisig: parameters.v3VoteScript.lolMultisig,
    maticAmountWeiForTransfer: parameters.v3VoteScript.maticAmountWeiForTransfer,
    transferReference: parameters.v3VoteScript.transferReference,
    easyTrackTrpRegistry: parameters.v3VoteScript.easyTrackTrpRegistry,
  };

  await deployWithoutProxy(Sk.v3VoteScript, "V3VoteScript", deployer, [voteScriptParams]);
}
