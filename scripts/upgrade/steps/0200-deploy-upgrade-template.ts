import { ethers } from "hardhat";
import { checkArtifactDeployedAndLog, readUpgradeParameters } from "scripts/utils/upgrade";

import { UpgradeTemplate__factory } from "typechain-types";
import { UpgradeParametersStruct } from "typechain-types/contracts/upgrade/UpgradeConfig";

import {
  ConstructorArgs,
  deployWithoutProxy,
  getAddress,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
} from "lib";

/**
 * Validates that `value` is a non-zero address and returns it unchanged, throwing otherwise.
 * Mirrors `UpgradeConfig._nonZeroAddress` so misconfigured params fail fast before deployment.
 */
function nonZeroAddress(value: unknown, name = "address"): string {
  if (typeof value !== "string" || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`Expected non-zero ${name} but got: ${value}`);
  }
  return value;
}

export async function skip(): Promise<boolean> {
  return await checkArtifactDeployedAndLog(Sk.upgradeTemplate);
}

export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = await ethers.provider.getSigner();

  await logScriptHeader("SRv3/CMv2 — Deploy UpgradeTemplate contract", deployer.address);

  const locatorAddress = getAddress(Sk.lidoLocator, state);

  const upgradeParams: UpgradeParametersStruct = {
    locator: nonZeroAddress(locatorAddress, "locator"),
    agent: nonZeroAddress(getAddress(Sk.appAgent, state), "agent"),
    voting: nonZeroAddress(getAddress(Sk.appVoting, state), "voting"),
    dualGovernance: nonZeroAddress(getAddress(Sk.dgDualGovernance, state), "dualGovernance"),
    easyTrack: nonZeroAddress(getAddress(Sk.easyTrack, state), "easyTrack"),
    circuitBreaker: nonZeroAddress(getAddress(Sk.circuitBreaker, state), "circuitBreaker"),
    circuitBreakerCommittee: nonZeroAddress(state[Sk.gateSeal].sealingCommittee, "circuitBreakerCommittee"),

    newFactories: {
      UpdateStakingModuleShareLimits: nonZeroAddress(
        parameters.easyTrack.newFactories.UpdateStakingModuleShareLimits,
        "newFactories.UpdateStakingModuleShareLimits",
      ),
      AllowConsolidationPair: nonZeroAddress(
        parameters.easyTrack.newFactories.AllowConsolidationPair,
        "newFactories.AllowConsolidationPair",
      ),
      SetMerkleGateTreeForCSM: nonZeroAddress(
        parameters.easyTrack.newFactories.SetMerkleGateTreeForCSM,
        "newFactories.SetMerkleGateTreeForCSM",
      ),
      ReportWithdrawalsForSlashedValidatorsForCSM: nonZeroAddress(
        parameters.easyTrack.newFactories.ReportWithdrawalsForSlashedValidatorsForCSM,
        "newFactories.ReportWithdrawalsForSlashedValidatorsForCSM",
      ),
      SettleGeneralDelayedPenaltyForCSM: nonZeroAddress(
        parameters.easyTrack.newFactories.SettleGeneralDelayedPenaltyForCSM,
        "newFactories.SettleGeneralDelayedPenaltyForCSM",
      ),
      SetMerkleGateTreeForCM: nonZeroAddress(
        parameters.easyTrack.newFactories.SetMerkleGateTreeForCM,
        "newFactories.SetMerkleGateTreeForCM",
      ),
      ReportWithdrawalsForSlashedValidatorsForCM: nonZeroAddress(
        parameters.easyTrack.newFactories.ReportWithdrawalsForSlashedValidatorsForCM,
        "newFactories.ReportWithdrawalsForSlashedValidatorsForCM",
      ),
      SettleGeneralDelayedPenaltyForCM: nonZeroAddress(
        parameters.easyTrack.newFactories.SettleGeneralDelayedPenaltyForCM,
        "newFactories.SettleGeneralDelayedPenaltyForCM",
      ),
      CreateOrUpdateOperatorGroupForCM: nonZeroAddress(
        parameters.easyTrack.newFactories.CreateOrUpdateOperatorGroupForCM,
        "newFactories.CreateOrUpdateOperatorGroupForCM",
      ),
    },
    oldFactories: {
      CSMSettleElStealingPenalty: nonZeroAddress(
        parameters.easyTrack.oldFactories.CSMSettleElStealingPenalty,
        "oldFactories.CSMSettleElStealingPenalty",
      ),
      CSMSetVettedGateTree: nonZeroAddress(
        parameters.easyTrack.oldFactories.CSMSetVettedGateTree,
        "oldFactories.CSMSetVettedGateTree",
      ),
    },

    coreUpgrade: {
      newLocatorImpl: nonZeroAddress(state[Sk.lidoLocator].implementation.address, "newLocatorImpl"),
      newLidoImpl: nonZeroAddress(state[Sk.appLido].implementation.address, "newLidoImpl"),
      newAccountingImpl: nonZeroAddress(state[Sk.accounting].implementation.address, "newAccountingImpl"),
      newAccountingOracleImpl: nonZeroAddress(
        state[Sk.accountingOracle].implementation.address,
        "newAccountingOracleImpl",
      ),
      newStakingRouterImpl: nonZeroAddress(state[Sk.stakingRouter].implementation.address, "newStakingRouterImpl"),
      newWithdrawalVaultImpl: nonZeroAddress(
        state[Sk.withdrawalVault].implementation.address,
        "newWithdrawalVaultImpl",
      ),
      newValidatorsExitBusOracleImpl: nonZeroAddress(
        state[Sk.validatorsExitBusOracle].implementation.address,
        "newValidatorsExitBusOracleImpl",
      ),
      consolidationBusImpl: nonZeroAddress(state[Sk.consolidationBus].implementation.address, "consolidationBusImpl"),
      consolidationMigratorImpl: nonZeroAddress(
        state[Sk.consolidationMigrator].implementation.address,
        "consolidationMigratorImpl",
      ),

      // TopUp GW
      topUpGatewayImpl: nonZeroAddress(state[Sk.topUpGateway].implementation.address, "topUpGatewayImpl"),
      topUpGatewayDepositor: nonZeroAddress(parameters.topUpGateway.depositor, "topUpGatewayDepositor"),

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
      consolidationBus: nonZeroAddress(getAddress(Sk.consolidationBus, state), "consolidationBus"),

      consolidationMigrator: nonZeroAddress(getAddress(Sk.consolidationMigrator, state), "consolidationMigrator"),
      consolidationCommittee: nonZeroAddress(
        parameters.consolidationMigrator.consolidationCommittee,
        "consolidationCommittee",
      ),

      lidoDepositsReserveTarget: parameters.lido.depositsReserveTarget,

      // StakingRouter
      maxTopUpPerBlockGwei: parameters.stakingRouter.maxTopUpPerBlockGwei,
    },
    csmUpgrade: {
      ...parameters.csmUpgrade,
      csmProxy: nonZeroAddress(parameters.csmUpgrade.csmProxy, "csmUpgrade.csmProxy"),
      csmImpl: nonZeroAddress(parameters.csmUpgrade.csmImpl, "csmUpgrade.csmImpl"),
      vettedGateProxy: nonZeroAddress(parameters.csmUpgrade.vettedGateProxy, "csmUpgrade.vettedGateProxy"),
      identifiedDVTClusterGate: nonZeroAddress(
        parameters.csmUpgrade.identifiedDVTClusterGate,
        "csmUpgrade.identifiedDVTClusterGate",
      ),
      identifiedDVTClusterCurveSetup: nonZeroAddress(
        parameters.csmUpgrade.identifiedDVTClusterCurveSetup,
        "csmUpgrade.identifiedDVTClusterCurveSetup",
      ),
      parametersRegistryImpl: nonZeroAddress(
        parameters.csmUpgrade.parametersRegistryImpl,
        "csmUpgrade.parametersRegistryImpl",
      ),
      feeOracleImpl: nonZeroAddress(parameters.csmUpgrade.feeOracleImpl, "csmUpgrade.feeOracleImpl"),
      vettedGateImpl: nonZeroAddress(parameters.csmUpgrade.vettedGateImpl, "csmUpgrade.vettedGateImpl"),
      accountingImpl: nonZeroAddress(parameters.csmUpgrade.accountingImpl, "csmUpgrade.accountingImpl"),
      feeDistributorImpl: nonZeroAddress(parameters.csmUpgrade.feeDistributorImpl, "csmUpgrade.feeDistributorImpl"),
      exitPenaltiesImpl: nonZeroAddress(parameters.csmUpgrade.exitPenaltiesImpl, "csmUpgrade.exitPenaltiesImpl"),
      strikesImpl: nonZeroAddress(parameters.csmUpgrade.strikesImpl, "csmUpgrade.strikesImpl"),
      oldPermissionlessGate: nonZeroAddress(
        parameters.csmUpgrade.oldPermissionlessGate,
        "csmUpgrade.oldPermissionlessGate",
      ),
      newPermissionlessGate: nonZeroAddress(
        parameters.csmUpgrade.newPermissionlessGate,
        "csmUpgrade.newPermissionlessGate",
      ),
      oldVerifier: nonZeroAddress(parameters.csmUpgrade.oldVerifier, "csmUpgrade.oldVerifier"),
      newVerifier: nonZeroAddress(parameters.csmUpgrade.newVerifier, "csmUpgrade.newVerifier"),
      newEjector: nonZeroAddress(parameters.csmUpgrade.newEjector, "csmUpgrade.newEjector"),
      csmCommittee: nonZeroAddress(parameters.csmUpgrade.csmCommittee, "csmUpgrade.csmCommittee"),
    },
    curatedModule: {
      ...parameters.curatedModule,
      module: nonZeroAddress(parameters.curatedModule.module, "curatedModule.module"),
      curatedGates: parameters.curatedModule.curatedGates.map((gate, i) =>
        nonZeroAddress(gate, `curatedModule.curatedGates[${i}]`),
      ),
      verifier: nonZeroAddress(parameters.curatedModule.verifier, "curatedModule.verifier"),
      circuitBreakerPauser: nonZeroAddress(
        parameters.curatedModule.circuitBreakerPauser,
        "curatedModule.circuitBreakerPauser",
      ),
    },
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
