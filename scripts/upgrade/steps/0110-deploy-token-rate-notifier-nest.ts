import readline from "node:readline";

import { ethers, network } from "hardhat";

import {
  bl,
  cy,
  deployBehindOssifiableProxy,
  deployImplementation,
  gr,
  log,
  mg,
  rd,
  readNetworkState,
  Sk,
  yl,
} from "lib";

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

  const agentAddress = state[Sk.appAgent].proxy.address;
  const accountingAddress = state[Sk.accounting].proxy.address;
  const locatorProxyAddress = state[Sk.lidoLocator].proxy.address;
  const locatorConfig = state[Sk.lidoLocator].implementation.constructorArgs[0];

  if (!agentAddress) throw new Error("Agent proxy address missing from state");
  if (!accountingAddress) throw new Error("Accounting proxy address missing from state");
  if (!locatorProxyAddress) throw new Error("LidoLocator proxy address missing from state");
  if (!locatorConfig || typeof locatorConfig !== "object") {
    throw new Error("LidoLocator implementation config struct missing from state");
  }

  const deployerBalance = await ethers.provider.getBalance(deployer);
  const { chainId } = await ethers.provider.getNetwork();

  log.splitter();
  log.header("TokenRateNotifier (NEST) — Deploy Implementations");
  log.splitter();

  log.info("Network", {
    "name": mg(network.name),
    "chain ID": mg(chainId.toString()),
  });

  log.info("Deployer", {
    address: bl(deployer),
    balance: `${gr(ethers.formatEther(deployerBalance))} ETH`,
  });

  log.info("TokenRateNotifier (behind OssifiableProxy, atomic initialize)", {
    "contract": cy("TokenRateNotifier"),
    "change: ": yl("adds ITokenRatePusherWithArgs flavor + moves under upgradeable proxy"),
    "impl ctor arg [0] tokenRateProvider_": bl(accountingAddress),
    "proxy admin": bl(agentAddress),
    "initialize arg [0] initialOwner_": bl(agentAddress),
  });

  log.info("LidoLocator implementation", {
    "contract": cy("LidoLocator"),
    "change: ": yl("retargets postTokenRebaseReceiver to the new TokenRateNotifier proxy"),
    "current postTokenRebaseReceiver": bl(locatorConfig.postTokenRebaseReceiver),
  });

  log.splitter();
  log(rd("Please review the parameters above carefully before proceeding."));
  log.splitter();

  await confirm(`Type ${gr("yes")} to confirm and start deployment: `);

  log.splitter();

  //
  // Deploy new TokenRateNotifier behind OssifiableProxy with atomic initialize.
  // OssifiableProxy delegatecalls `initData` on the impl as part of its constructor — owner is
  // set in the proxy's storage atomically with deployment, no front-run window.
  //
  const notifierFactory = await ethers.getContractFactory("TokenRateNotifier");
  const initData = notifierFactory.interface.encodeFunctionData("initialize", [agentAddress]);

  const newNotifierProxy = await deployBehindOssifiableProxy(
    Sk.tokenRebaseNotifierNest,
    "TokenRateNotifier",
    agentAddress,
    deployer,
    [accountingAddress],
    null,
    true,
    undefined,
    initData,
  );

  //
  // Deploy new LidoLocator implementation with `postTokenRebaseReceiver` overridden. All other
  // fields are preserved from the current config in the state file.
  //
  const newLocatorConfig = {
    ...locatorConfig,
    postTokenRebaseReceiver: newNotifierProxy.address,
  };
  const newLocatorImpl = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [newLocatorConfig]);

  log.splitter();
  log.header("Deployment complete");
  log.info("Summary", {
    "New TokenRateNotifier (proxy)": bl(newNotifierProxy.address),
    "New LidoLocator implementation": bl(newLocatorImpl.address),
    "Target postTokenRebaseReceiver": bl(newNotifierProxy.address),
  });
  log.splitter();
}
