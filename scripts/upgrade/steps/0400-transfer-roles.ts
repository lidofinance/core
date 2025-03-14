import { ethers } from "hardhat";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState();

  const upgradeTemplate = state[Sk.upgradeTemplateV3].address;

  // Transfer OZ admin roles for various contracts
  const ozAdminTransfers = [{ name: "Burner", address: state[Sk.burner].address, recipient: upgradeTemplate }];

  for (const params of ozAdminTransfers) {
    const contractInstance = await loadContract(params.name, params.address);
    await makeTx(contractInstance, "grantRole", [DEFAULT_ADMIN_ROLE, params.recipient], { from: deployer });
    await makeTx(contractInstance, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });
  }
}
