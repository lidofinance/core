import { assert } from "chai";
import { ethers } from "hardhat";

import { ENS } from "typechain-types";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { streccak } from "lib/keccak";
import { cy, log, mg, yl } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";

const TLD = "eth";

export async function main() {
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState({ deployer });

  // Load ENS contract
  log(`Using ENS: ${cy(state[Sk.ens].address)}`);
  const ens = await loadContract<ENS>("ENS", state[Sk.ens].address, deployerSigner);

  const tldNode = ethers.namehash(TLD);
  const domainName = state[Sk.lidoApmEnsName];
  const domainOwner = state[Sk.lidoTemplate].address;
  const node = ethers.namehash(domainName);

  // Validate domain name
  const domainParts = domainName.split(".");
  assert.lengthOf(domainParts, 2, `the domain is a second-level domain`);
  assert.equal(domainParts[1], TLD, `the TLD is the expected one`);
  const [domainLabel] = domainParts;

  const labelHash = streccak(domainLabel);

  log(` ENS domain: ${yl(`${domainName}`)} (${mg(node)})`);
  log(` TLD node: ${yl(TLD)} (${mg(tldNode)})`);
  log(` Label: ${yl(domainLabel)} (${mg(labelHash)})`);
  log.emptyLine();

  // Check ownership and perform necessary actions
  const nodeOwner = await ens.owner(node);
  const tldNodeOwner = await ens.owner(tldNode);

  if (nodeOwner !== deployer && tldNodeOwner !== deployer) {
    throw new Error(`This branch is not implemented.
      For the previous implementation see
      https://github.com/lidofinance/lido-dao/blob/5fcedc6e9a9f3ec154e69cff47c2b9e25503a78a/scripts/scratch/06-register-ens-domain.js#L57
    `);
  }

  log(`ENS domain new owner:`, cy(domainOwner));
  log.emptyLine();

  if (nodeOwner === deployer) {
    await makeTx(ens, "setOwner", [node, domainOwner], { from: deployer });
  } else {
    await makeTx(ens, "setSubnodeOwner", [tldNode, labelHash, domainOwner], { from: deployer });
  }
}
