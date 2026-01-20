import assert from "assert";
import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { deployImplementation, Sk } from "lib";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const parameters = readUpgradeParameters(true);
  const pdgDeployParams = parameters.predepositGuarantee;

  //
  // New PredepositGuarantee implementation
  //
  const predepositGuarantee = await deployImplementation(Sk.predepositGuarantee, "PredepositGuarantee", deployer, [
    pdgDeployParams.genesisForkVersion,
    pdgDeployParams.gIndex,
    pdgDeployParams.gIndexAfterChange,
    pdgDeployParams.changeSlot,
  ]);
  const newPredepositGuaranteeAddress = await predepositGuarantee.getAddress();
  console.log("New PredepositGuarantee implementation address", newPredepositGuaranteeAddress);
}
