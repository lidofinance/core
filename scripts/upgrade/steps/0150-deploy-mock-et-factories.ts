import { artifacts, ethers } from "hardhat";
import { readUpgradeParameters, writeUpgradeEasyTrackFactoryAddress } from "scripts/utils/upgrade";

import {
  bl,
  deployWithoutProxy,
  isContractDeployed,
  log,
  or,
  readNetworkState,
  Sk,
  updateObjectInState,
  yl,
} from "lib";

type EasyTrackFactoriesStateMap = Partial<Record<Sk, string[]>>;
const EASY_TRACK_NEW_FACTORIES_SECTION = "easyTrack.newFactories";

export const easyTrackFactoriesStateMap = {
  [Sk.stakingRouter]: ["UpdateStakingModuleShareLimits"],
  [Sk.consolidationMigrator]: ["AllowConsolidationPair"],
  [Sk.csm_CSM]: ["SetMerkleGateTree", "ReportWithdrawalsForSlashedValidators", "SettleGeneralDelayedPenalty"],
  [Sk.csm_CM]: [
    "SetMerkleGateTree",
    "ReportWithdrawalsForSlashedValidators",
    "SettleGeneralDelayedPenalty",
    "CreateOrUpdateOperatorGroup",
  ],
} satisfies EasyTrackFactoriesStateMap;

function getFactoryParamName(contractKey: Sk, etName: string): string {
  if (contractKey === Sk.csm_CSM) {
    return `${etName}ForCSM`;
  }

  if (contractKey === Sk.csm_CM) {
    return `${etName}ForCM`;
  }

  return etName;
}

export async function main() {
  log.splitter();
  log.header("[Mocks] Deploy EasyTrack factories");

  const deployer = (await ethers.provider.getSigner()).address;
  let state = readNetworkState();
  const parameters = readUpgradeParameters();

  // deploy ET

  for (const [contractKey, etNames] of Object.entries(easyTrackFactoriesStateMap) as [Sk, string[]][]) {
    const deployedFactories: Record<string, string> = { ...(state[contractKey]?.easyTrackFactories ?? {}) };

    for (const etName of etNames) {
      const paramName = getFactoryParamName(contractKey, etName) as keyof typeof parameters.easyTrack.newFactories;
      const paramAddress = parameters.easyTrack.newFactories[paramName];
      const isParamDeployed = paramAddress ? await isContractDeployed(paramAddress) : false;

      if (isParamDeployed) {
        log.success(`Skip ${yl(paramName)}[${bl(paramAddress)}] - found in parameters`);
        deployedFactories[etName] = paramAddress;
        state = updateObjectInState(contractKey, { easyTrackFactories: deployedFactories });
        continue;
      }

      const stateAddress = deployedFactories[etName];
      const isStateDeployed = stateAddress ? await isContractDeployed(stateAddress) : false;

      if (isStateDeployed) {
        log.success(`Skip ${yl(paramName)}[${bl(stateAddress)}] - found in state`);
        writeUpgradeEasyTrackFactoryAddress(EASY_TRACK_NEW_FACTORIES_SECTION, paramName, stateAddress);
        continue;
      }

      const preferredArtifactName = `${etName}Mock`;
      let artifactName = preferredArtifactName;
      try {
        await artifacts.readArtifact(preferredArtifactName);
      } catch {
        artifactName = "EasyTrackFactoryMock";
      }

      const deployedContract = await deployWithoutProxy(contractKey, artifactName, deployer, [], "address", false);
      log.success(`Deployed ${or(artifactName)} aa ${yl(paramName)}[${bl(deployedContract.address)}]`);
      deployedFactories[etName] = deployedContract.address;
      state = updateObjectInState(contractKey, { easyTrackFactories: deployedFactories });
      writeUpgradeEasyTrackFactoryAddress(EASY_TRACK_NEW_FACTORIES_SECTION, paramName, deployedContract.address);
    }
  }
}
