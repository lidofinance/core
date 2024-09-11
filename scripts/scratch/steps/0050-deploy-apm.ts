import { assert } from "chai";
import { ethers } from "hardhat";

import { ENS, LidoTemplate } from "typechain-types";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { getENSNodeOwner } from "lib/ens";
import { findEvents } from "lib/event";
import { streccak } from "lib/keccak";
import { cy, log, mg, yl } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

function splitDomain(domain: string) {
  const dotIndex = domain.indexOf(".");
  if (dotIndex === -1) {
    throw new Error(`the ENS domain ${domain} is a top-level domain`);
  }
  return {
    sub: domain.substring(0, dotIndex),
    parent: domain.substring(dotIndex + 1),
  };
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });
  const templateAddress = state.lidoTemplate.address;

  log(`APM ENS domain: ${yl(state.lidoApmEnsName)}`);
  log(`Using DAO template: ${cy(templateAddress)}`);
  log.emptyLine();

  // Load ENS contract and check ownership
  const ens = await loadContract<ENS>("ENS", state[Sk.ens].address);
  const lidoApmEnsNode = ethers.namehash(state.lidoApmEnsName);
  const lidoApmEnsNodeOwner = await getENSNodeOwner(ens, lidoApmEnsNode);
  const checkDesc = `ENS node is owned by the DAO template`;

  assert.equal(lidoApmEnsNodeOwner, templateAddress, checkDesc);
  log.success(checkDesc);
  log.emptyLine();

  // Split domain and calculate hashes
  const domain = splitDomain(state.lidoApmEnsName);
  const parentHash = ethers.namehash(domain.parent);
  const subHash = streccak(domain.sub);

  log(`Parent domain: ${yl(domain.parent)} (${mg(parentHash)})`);
  log(`Subdomain label: ${yl(domain.sub)} (${mg(subHash)})`);
  log.emptyLine();

  // Deploy Lido APM
  const template = await loadContract<LidoTemplate>("LidoTemplate", templateAddress);
  const lidoApmDeployArguments = [parentHash, subHash];
  const receipt = await makeTx(template, "deployLidoAPM", lidoApmDeployArguments, { from: deployer });
  updateObjectInState(Sk.lidoApm, {
    deployArguments: lidoApmDeployArguments,
    deployTx: receipt.hash,
  });

  // Get and log the deployed APMRegistry address
  const registryAddress = findEvents(receipt, "TmplAPMDeployed")[0].args.apm;

  log(`Using APMRegistry: ${cy(registryAddress)}`);
  log.emptyLine();

  updateObjectInState(Sk.lidoApm, { address: registryAddress });
}
