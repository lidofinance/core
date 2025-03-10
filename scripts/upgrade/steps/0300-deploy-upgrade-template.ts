import { ethers } from "hardhat";

import { deployWithoutProxy } from "lib/deploy";
import { Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;

  await deployWithoutProxy(Sk.upgradeTemplateV3, "UpgradeTemplateV3", deployer);
}
