import { assert } from "chai";
import chalk from "chalk";
import { ethers } from "hardhat";

import { ENS, ENS__factory } from "typechain-types";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { streccak } from "lib/keccak";
import { log, yl } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";

const TLD = "eth";

async function main() {
  log.scriptStart(__filename);
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState({ deployer });

  log(`Using ENS:`, yl(state[Sk.ens].address));
  const ens = await loadContract<ENS>(ENS__factory, state[Sk.ens].address, deployerSigner);

  const tldNode = ethers.namehash(TLD);

  const domainName = state[Sk.lidoApmEnsName];
  const domainOwner = state[Sk.lidoTemplate].address;

  const node = ethers.namehash(domainName);

  log(`ENS domain: ${yl(`${domainName}`)} (${node})`);

  const domainParts = domainName.split(".");
  assert.lengthOf(domainParts, 2, `the domain is a second-level domain`);
  assert.equal(domainParts[1], TLD, `the TLD is the expected one`);
  const [domainLabel] = domainParts;

  const labelHash = streccak(domainLabel);

  log(`TLD node: ${chalk.yellow(TLD)} (${tldNode})`);
  log(`Label: ${chalk.yellow(domainLabel)} (${labelHash})`);

  if ((await ens.owner(node)) !== deployer && (await ens.owner(tldNode)) !== deployer) {
    throw new Error(`This branch is not implemented.
      For the previous implementation see
      https://github.com/lidofinance/lido-dao/blob/5fcedc6e9a9f3ec154e69cff47c2b9e25503a78a/scripts/scratch/06-register-ens-domain.js#L57
    `);
  } else {
    log(`ENS domain new owner:`, yl(domainOwner));
    if ((await ens.owner(node)) === deployer) {
      log(`Transferring name ownership from owner ${chalk.yellow(deployer)} to template ${chalk.yellow(domainOwner)}`);
      await makeTx(ens, "setOwner", [node, domainOwner], { from: deployer });
    } else {
      log(`Creating the subdomain and assigning it to template ${chalk.yellow(domainOwner)}`);
      await makeTx(ens, "setSubnodeOwner", [tldNode, labelHash, domainOwner], {
        from: deployer,
      });
    }
  }

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
