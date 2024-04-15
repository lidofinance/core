import { assert } from "chai";
import chalk from "chalk";
import { ethers } from "hardhat";

import { ENS, ENS__factory, LidoTemplate, LidoTemplate__factory } from "typechain-types";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { getENSNodeOwner } from "lib/ens";
import { findEvents } from "lib/event";
import { streccak } from "lib/keccak";
import { log, logSplitter, yl } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

async function main() {
  log.scriptStart(__filename);

  const deployer = (await ethers.provider.getSigner()).address;
  let state = readNetworkState({ deployer });
  const templateAddress = state.lidoTemplate.address;

  logSplitter();
  log(`APM ENS domain: ${chalk.yellow(state.lidoApmEnsName)}`);
  log(`Using DAO template: ${chalk.yellow(templateAddress)}`);

  const ens = await loadContract<ENS>(ENS__factory, state[Sk.ens].address);
  const lidoApmEnsNode = ethers.namehash(state.lidoApmEnsName);
  const lidoApmEnsNodeOwner = await getENSNodeOwner(ens, lidoApmEnsNode);
  const checkDesc = `ENS node is owned by the DAO template`;

  assert.equal(lidoApmEnsNodeOwner, templateAddress, checkDesc);
  log.success(checkDesc);

  logSplitter();

  const domain = splitDomain(state.lidoApmEnsName);
  const parentHash = ethers.namehash(domain.parent);
  const subHash = streccak(domain.sub);

  log(`Parent domain: ${chalk.yellow(domain.parent)} ${parentHash}`);
  log(`Subdomain label: ${chalk.yellow(domain.sub)} ${subHash}`);

  logSplitter();

  const template = await loadContract<LidoTemplate>(LidoTemplate__factory, templateAddress);
  const lidoApmDeployArguments = [parentHash, subHash];
  const receipt = await makeTx(template, "deployLidoAPM", lidoApmDeployArguments, { from: deployer });
  state = updateObjectInState(Sk.lidoApm, {
    deployArguments: lidoApmDeployArguments,
    deployTx: receipt.hash,
  });

  const registryAddress = findEvents(receipt, "TmplAPMDeployed")[0].args.apm;
  log.splitter(`Using APMRegistry: ${yl(registryAddress)}`);

  state = updateObjectInState(Sk.lidoApm, { address: registryAddress });

  log.scriptFinish(__filename);
}

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

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
