import chalk from "chalk";
import { ethers } from "hardhat";

import { ENS } from "typechain-types";

import { LoadedContract, log, makeTx, streccak } from "lib";

// Default parentName is "eth"
export async function assignENSName(
  parentName: string,
  labelName: string,
  owner: string,
  ens: ENS,
  assigneeAddress: string,
  assigneeDesc: string,
) {
  const assigneeFullDesc = assigneeDesc ? `${assigneeDesc} at ${assigneeAddress}` : assigneeAddress;
  log(`Assigning ENS name '${labelName}.${parentName}' to ${assigneeFullDesc}...`);

  const parentNode = ethers.namehash(parentName);
  const labelHash = streccak(labelName);
  const nodeName = `${labelName}.${parentName}`;
  const node = ethers.namehash(nodeName);

  log(`Node: ${chalk.yellow(nodeName)} (${node})`);
  log(`Parent node: ${chalk.yellow(parentName)} (${parentNode})`);
  log(`Label: ${chalk.yellow(labelName)} (${labelHash})`);

  let receipt;
  if ((await ens.owner(node)) === owner) {
    receipt = await makeTx(ens as unknown as LoadedContract, "setOwner", [node, assigneeAddress], { from: owner });
  } else {
    if ((await ens.owner(parentNode)) !== owner) {
      throw new Error(
        `the address ${owner} has no ownership rights over the target ` +
          `domain '${labelName}.${parentName}' or parent domain '${parentName}'`,
      );
    }
    try {
      receipt = await makeTx(
        ens as unknown as LoadedContract,
        "setSubnodeOwner",
        [parentNode, labelHash, assigneeAddress],
        {
          from: owner,
        },
      );
    } catch (err) {
      log(
        `Error: could not set the owner of '${labelName}.${parentName}' on the given ENS instance`,
        `(${await ens.getAddress()}). Make sure you have ownership rights over the subdomain.`,
      );
      throw err;
    }
  }

  return { receipt, parentNode, labelHash, nodeName, node };
}

export async function getENSNodeOwner(ens: ENS, node: string) {
  const ownerAddr = await ens.owner(node);
  return ownerAddr == ethers.ZeroAddress ? null : ownerAddr;
}
