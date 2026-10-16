import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  LidoLocator,
  OssifiableProxy__factory,
  UpgradeTemplate__factory,
  UpgradeVoteScript__factory,
} from "typechain-types";
import { UpgradeParametersStruct } from "typechain-types/contracts/upgrade/UpgradeTemplate";
import { UpgradeVoteScript } from "typechain-types/contracts/upgrade/UpgradeVoteScript";

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
  persistNetworkState,
  readNetworkState,
  Sk,
  updateObjectInState,
} from "lib";

function nonZeroAddress(value: string | undefined, field: string): string {
  if (!value || /^0x0{40}$/i.test(value)) throw new Error(`${field} is missing in the deployment state`);
  return value;
}

/**
 * Deploys `UpgradeTemplate` (which builds `UpgradeConfig` in its constructor) and the
 * `UpgradeVoteScript` omnibus on top of it.
 *
 * @dev The outgoing verifier, consolidation gateway and locator implementation are read from the
 *      live locator, not from the state file: `0400` has already overwritten those entries with the
 *      incoming addresses. The locator proxy is still untouched at this point, so it answers with
 *      the addresses the vote is about to replace.
 *
 * @dev No `skip()`, for the same reason as in `0400`: `Sk.upgradeTemplate` and `Sk.upgradeVoteScript`
 *      still hold the enacted SRv3 artifacts, so the check would skip this step. Following the EDF
 *      precedent, those keys are overwritten by each release.
 */
export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("Gloas — Deploy UpgradeTemplate and vote script", deployer);

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const locatorProxy = OssifiableProxy__factory.connect(locatorAddress, await getDeployerSigner());

  // The template's constructor rejects a mismatch against `block.chainid`, which is what makes a
  // config built for one network unusable on another. Ask the node rather than the Hardhat config:
  // the `local` network declares no chainId and takes it from whatever it is pointed at.
  const { chainId } = await ethers.provider.getNetwork();

  const upgradeParams: UpgradeParametersStruct = {
    chainId,

    voting: getAddress(Sk.appVoting, state),
    agent: getAddress(Sk.appAgent, state),
    dualGovernance: nonZeroAddress(getAddress(Sk.dgDualGovernance, state), "dualGovernance"),

    locator: locatorAddress,
    locatorAdmin: await locatorProxy.proxy__getAdmin(),
    oldLocatorImplementation: await locatorProxy.proxy__getImplementation(),
    newLocatorImplementation: state[Sk.lidoLocator].implementation.address,

    stakingRouter: getAddress(Sk.stakingRouter, state),
    circuitBreaker: nonZeroAddress(getAddress(Sk.circuitBreaker, state), "circuitBreaker"),
    circuitBreakerCommittee: nonZeroAddress(state[Sk.gateSeal].sealingCommittee, "circuitBreakerCommittee"),
    resealManager: nonZeroAddress(getAddress(Sk.resealManager, state), "resealManager"),

    predepositGuarantee: getAddress(Sk.predepositGuarantee, state),
    newPredepositGuaranteeImpl: state[Sk.predepositGuarantee].implementation.address,
    topUpGateway: getAddress(Sk.topUpGateway, state),
    newTopUpGatewayImpl: state[Sk.topUpGateway].implementation.address,
    consolidationBus: getAddress(Sk.consolidationBus, state),
    newConsolidationBusImpl: state[Sk.consolidationBus].implementation.address,
    withdrawalVault: getAddress(Sk.withdrawalVault, state),
    newWithdrawalVaultImpl: state[Sk.withdrawalVault].implementation.address,

    oldValidatorExitDelayVerifier: await locator.validatorExitDelayVerifier(),
    newValidatorExitDelayVerifier: getAddress(Sk.validatorExitDelayVerifier, state),
    oldConsolidationGateway: await locator.consolidationGateway(),
    newConsolidationGateway: getAddress(Sk.consolidationGateway, state),
  };

  const templateConstructorArgs: ConstructorArgs<UpgradeTemplate__factory> = [
    upgradeParams,
    parameters.upgradeVoteScript.expiryTimestamp,
  ];

  logStartReview();
  await logArgs("UpgradeTemplate", templateConstructorArgs);
  await logConfirmReview();

  const template = await deployWithoutProxy(Sk.upgradeTemplate, "UpgradeTemplate", deployer, templateConstructorArgs);

  const configAddress = await template.getFunction("CONFIG")();
  updateObjectInState(Sk.upgradeConfig, {
    contract: await getContractPath("UpgradeConfig"),
    address: configAddress,
    constructorArgs: [upgradeParams],
  });

  const scriptParams: UpgradeVoteScript.ScriptParamsStruct = { upgradeTemplate: template.address };
  const voteScriptConstructorArgs: ConstructorArgs<UpgradeVoteScript__factory> = [scriptParams];

  logStartReview();
  await logArgs("UpgradeVoteScript", voteScriptConstructorArgs);
  await logConfirmReview();

  await deployWithoutProxy(Sk.upgradeVoteScript, "UpgradeVoteScript", deployer, voteScriptConstructorArgs);

  const updatedState = readNetworkState();
  delete updatedState[Sk.upgradeVoteScript].voteState;
  persistNetworkState(updatedState);
}
