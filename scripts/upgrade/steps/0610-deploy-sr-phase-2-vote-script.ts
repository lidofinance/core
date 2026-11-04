import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  LidoLocator,
  OssifiableProxy__factory,
  SRPhase2UpgradeTemplate__factory,
  SRPhase2UpgradeVoteScript__factory,
} from "typechain-types";
import {
  GatewayConsumerLimitsStruct,
  SRPhase2UpgradeParametersStruct,
} from "typechain-types/contracts/upgrade/sr-phase-2/SRPhase2UpgradeTemplate";
import { SRPhase2UpgradeVoteScript } from "typechain-types/contracts/upgrade/sr-phase-2/SRPhase2UpgradeVoteScript";

import {
  ConstructorArgs,
  deployWithoutProxy,
  getAddress,
  getContractPath,
  getDeployerSigner,
  loadContract,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
  updateObjectInState,
} from "lib";

function nonZeroAddress(value: string | undefined, field: string): string {
  if (!value || /^0x0{40}$/i.test(value)) throw new Error(`${field} is missing in the deployment state`);
  return value;
}

/**
 * Deploys `SRPhase2UpgradeTemplate` (which builds `SRPhase2UpgradeConfig` in its constructor) and the
 * `SRPhase2UpgradeVoteScript` omnibus on top of it.
 *
 * @dev The outgoing gateway, verifier and locator implementation are read from the live locator, not from
 *      the state file: `0600` has already overwritten those entries with the incoming addresses.
 */
export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("SR phase 2 (LIP-38) — Deploy upgrade template and vote script", deployer);

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const locatorProxy = OssifiableProxy__factory.connect(locatorAddress, await getDeployerSigner());
  // The live locator still lists the verifier this upgrade removes
  const liveLocator = new ethers.Contract(
    locatorAddress,
    ["function validatorExitDelayVerifier() view returns (address)"],
    ethers.provider,
  );

  // The template's constructor rejects a mismatch against `block.chainid`; ask the node rather than the config
  const { chainId } = await ethers.provider.getNetwork();

  // The vote sets these limits on the new gateway in the order of its items, each naming its consumer,
  // so the ejectors are picked by name rather than by their order in the parameters file
  const triggerableWithdrawalsBusAddress = getAddress(Sk.triggerableWithdrawalsBus, state);
  const { busLimits, ejectors } = parameters.triggerableWithdrawalsGateway;
  const ejectorNames = ["CSM", "CSM 0x02", "CMv2"];
  if (ejectors.length !== ejectorNames.length) {
    throw new Error(`Expected ejectors ${ejectorNames.join(", ")}, got ${ejectors.map((e) => e.name).join(", ")}`);
  }
  const ejectorLimits = (name: string): GatewayConsumerLimitsStruct => {
    const ejector = ejectors.find((e) => e.name === name);
    if (!ejector) throw new Error(`Missing ejector "${name}" in the upgrade parameters`);
    return { consumer: ejector.address, pwrLimit: ejector.pwr, fwrLimit: ejector.fwr };
  };
  const gatewayConsumers: GatewayConsumerLimitsStruct[] = [
    { consumer: triggerableWithdrawalsBusAddress, pwrLimit: busLimits.pwr, fwrLimit: busLimits.fwr },
    ...ejectorNames.map(ejectorLimits),
  ];

  // The Aragon Voting removes these factories before the template runs, so the template cannot vet them:
  // check here that each one is live in Easy Track and submits hashes to this VEBO
  const validatorsExitBusOracle = await locator.validatorsExitBusOracle();
  const easyTrackAddress = nonZeroAddress(getAddress(Sk.easyTrack, state), "easyTrack");
  const easyTrack = new ethers.Contract(
    easyTrackAddress,
    ["function evmScriptExecutor() view returns (address)", "function isEVMScriptFactory(address) view returns (bool)"],
    ethers.provider,
  );
  const { curatedSubmitExitRequestHashesFactory, sdvtSubmitExitRequestHashesFactory } =
    parameters.srPhase2UpgradeVoteScript;
  for (const factory of [curatedSubmitExitRequestHashesFactory, sdvtSubmitExitRequestHashesFactory]) {
    if (!(await easyTrack.isEVMScriptFactory(factory))) {
      throw new Error(`${factory} is not an Easy Track factory`);
    }
    const hashFactory = new ethers.Contract(
      factory,
      ["function validatorsExitBusOracle() view returns (address)"],
      ethers.provider,
    );
    if ((await hashFactory.validatorsExitBusOracle()).toLowerCase() !== validatorsExitBusOracle.toLowerCase()) {
      throw new Error(`Easy Track factory ${factory} does not submit exit request hashes to the VEBO`);
    }
  }

  const upgradeParams: SRPhase2UpgradeParametersStruct = {
    chainId,

    voting: getAddress(Sk.appVoting, state),
    agent: getAddress(Sk.appAgent, state),
    dualGovernance: nonZeroAddress(getAddress(Sk.dgDualGovernance, state), "dualGovernance"),

    locator: locatorAddress,
    locatorAdmin: await locatorProxy.proxy__getAdmin(),
    oldLocatorImplementation: await locatorProxy.proxy__getImplementation(),
    newLocatorImplementation: state[Sk.lidoLocator].implementation.address,

    validatorsExitBusOracle,
    circuitBreaker: nonZeroAddress(getAddress(Sk.circuitBreaker, state), "circuitBreaker"),
    circuitBreakerCommittee: nonZeroAddress(state[Sk.gateSeal].sealingCommittee, "circuitBreakerCommittee"),
    resealManager: nonZeroAddress(getAddress(Sk.resealManager, state), "resealManager"),

    stakingRouter: getAddress(Sk.stakingRouter, state),
    newStakingRouterImpl: state[Sk.stakingRouter].implementation.address,
    withdrawalVault: getAddress(Sk.withdrawalVault, state),
    newWithdrawalVaultImpl: state[Sk.withdrawalVault].implementation.address,

    oldTriggerableWithdrawalsGateway: await locator.triggerableWithdrawalsGateway(),
    newTriggerableWithdrawalsGateway: getAddress(Sk.triggerableWithdrawalsGateway, state),
    triggerableWithdrawalsBus: triggerableWithdrawalsBusAddress,

    validatorExitDelayVerifier: await liveLocator.validatorExitDelayVerifier(),

    easyTrack: easyTrackAddress,
    easyTrackEvmScriptExecutor: await easyTrack.evmScriptExecutor(),
    curatedSubmitExitRequestHashesFactory,
    sdvtSubmitExitRequestHashesFactory,

    gatewayConsumers,
  };

  const templateConstructorArgs: ConstructorArgs<SRPhase2UpgradeTemplate__factory> = [
    upgradeParams,
    parameters.srPhase2UpgradeVoteScript.expiryTimestamp,
  ];

  logStartReview();
  await logArgs("SRPhase2UpgradeTemplate", templateConstructorArgs);
  await logConfirmReview();

  const template = await deployWithoutProxy(
    Sk.srPhase2UpgradeTemplate,
    "SRPhase2UpgradeTemplate",
    deployer,
    templateConstructorArgs,
  );

  const configAddress = await template.getFunction("CONFIG")();
  updateObjectInState(Sk.srPhase2UpgradeConfig, {
    contract: await getContractPath("SRPhase2UpgradeConfig"),
    address: configAddress,
    constructorArgs: [upgradeParams],
  });

  const scriptParams: SRPhase2UpgradeVoteScript.ScriptParamsStruct = { upgradeTemplate: template.address };
  const voteScriptConstructorArgs: ConstructorArgs<SRPhase2UpgradeVoteScript__factory> = [scriptParams];

  logStartReview();
  await logArgs("SRPhase2UpgradeVoteScript", voteScriptConstructorArgs);
  await logConfirmReview();

  await deployWithoutProxy(
    Sk.srPhase2UpgradeVoteScript,
    "SRPhase2UpgradeVoteScript",
    deployer,
    voteScriptConstructorArgs,
  );
}
