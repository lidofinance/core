import readline from "node:readline";

import { ethers, network } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { bl, cy, deployImplementation, gr, log, mg, rd, readNetworkState, Sk, yl } from "lib";

async function confirm(question: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question(question, (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "yes") {
        resolve();
      } else {
        reject(new Error(`Aborted by user (got "${answer.trim()}")`));
      }
    });
  });
}

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState();

  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const lidoAddress = state[Sk.appLido].proxy.address;
  const hashConsensusAddress = state[Sk.hashConsensusForAccountingOracle].address;
  const { maxRelativeShareLimitBP } = readUpgradeParameters(true).vaultHub!;
  if (maxRelativeShareLimitBP === undefined) {
    throw new Error("vaultHub.maxRelativeShareLimitBP is not set in upgrade parameters");
  }

  const deployerBalance = await ethers.provider.getBalance(deployer);
  const { chainId } = await ethers.provider.getNetwork();

  log.splitter();
  log.header("Lido V3.0.2 — Deploy Implementations");
  log.splitter();

  log.info("Network", {
    "name": mg(network.name),
    "chain ID": mg(chainId.toString()),
  });

  log.info("Deployer", {
    address: bl(deployer),
    balance: `${gr(ethers.formatEther(deployerBalance))} ETH`,
  });

  log.info("LazyOracle implementation", {
    "contract": cy("LazyOracle"),
    "fix: ": yl("removes redundant _maxLiabilityShares > record.maxLiabilityShares check"),
    "constructor arg [0] _lidoLocator": bl(locatorAddress),
  });

  log.info("VaultHub implementation", {
    "contract": cy("VaultHub"),
    "fix: ": yl("forbids partial withdrawals for vaults with obligations shortfall"),
    "constructor arg [0] _locator": bl(locatorAddress),
    "constructor arg [1] _lido": bl(lidoAddress),
    "constructor arg [2] _consensusContract": bl(hashConsensusAddress),
    "constructor arg [3] _maxRelativeShareLimitBP": yl(maxRelativeShareLimitBP.toString()),
  });

  log.splitter();
  log(rd("Please review the parameters above carefully before proceeding."));
  log.splitter();

  await confirm(`Type ${gr("yes")} to confirm and start deployment: `);

  log.splitter();

  //
  // Deploy LazyOracle new implementation
  // Fix: removes redundant _maxLiabilityShares > record.maxLiabilityShares check
  //
  await deployImplementation(Sk.lazyOracle, "LazyOracle", deployer, [locatorAddress]);

  //
  // Deploy VaultHub new implementation
  // Fix: forbids partial withdrawals for vaults with obligations shortfall
  //
  await deployImplementation(Sk.vaultHub, "VaultHub", deployer, [
    locatorAddress,
    lidoAddress,
    hashConsensusAddress,
    maxRelativeShareLimitBP,
  ]);
}
