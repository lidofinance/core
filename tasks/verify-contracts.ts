import fs from "node:fs/promises";
import path from "node:path";

import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

import { cy, log, yl } from "lib/log.js";

type DeployedContract = {
  contract: string;
  contractName?: string;
  address: string;
  constructorArgs: unknown[];
};

type ProxyContract = {
  proxy: DeployedContract;
  implementation: DeployedContract;
};

type ImplementationContract = {
  implementation: DeployedContract;
};

type Contract = DeployedContract | ProxyContract | ImplementationContract;

type NetworkState = {
  deployer: string;
  [key: string]: Contract | string | number;
};

const errors = [] as string[];

export const verifyDeployedTask = task("verify:deployed", "Verifies deployed contracts based on state file")
  .addOption({ name: "file", description: "Path to network state file", defaultValue: "" })
  .addOption({ name: "only", description: "Comma-separated list of paths to contracts to verify", defaultValue: "" })
  .setInlineAction(async (taskArgs, hre) => {
    try {
      const { networkName } = await hre.network.connect();
      log("Verifying contracts for network:", networkName);

      const networkStateFile = taskArgs.file || `deployed-${networkName}.json`;
      log("Using network state file:", networkStateFile);

      const networkStateFilePath = path.resolve("./", networkStateFile);
      const data = await fs.readFile(networkStateFilePath, "utf8");
      const networkState = JSON.parse(data) as NetworkState;
      const onlyContracts = taskArgs.only ? taskArgs.only.split(",") : [];

      const deployedContracts = Object.values(networkState)
        .filter((c): c is Contract => typeof c === "object")
        .flatMap(getDeployedContract)
        .filter((c) => (onlyContracts.length > 0 ? onlyContracts.includes(c.contract ?? "") : true));

      // Not using Promise.all to avoid logging messages out of order
      for (const contract of deployedContracts) {
        if (!contract.contract || !contract.address) {
          log.error("Invalid contract:", contract);
          log.emptyLine();
          continue;
        }

        await verifyDeployedContract(contract, hre);
      }
    } catch (error) {
      log.error("Error verifying deployed contracts:", error as Error);
      throw error;
    }

    if (errors.length > 0) {
      log.error(`Failed to verify ${errors.length} contract(s):`, errors as string[]);
      process.exitCode = errors.length;
    }
  })
  .build();

async function verifyDeployedContract(contract: DeployedContract, hre: HardhatRuntimeEnvironment) {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  if (!contract.contract) {
    log.warning("Skipping contract without contract name:", contract);
    return;
  }

  log.splitter();

  const contractName = contract.contractName ?? contract.contract.split("/").pop()?.split(".")[0];
  const constructorArgs = contract.constructorArgs ?? [];
  const contractFqn = `${contract.contract}:${contractName}`;

  log.withArguments(
    `Verifying contract: ${yl(contract.contract)} at ${cy(contract.address)} with constructor args `,
    constructorArgs as string[],
  );

  try {
    await verifyContract(
      {
        address: contract.address,
        constructorArgs,
        contract: contractFqn,
        provider: "etherscan",
      },
      hre,
    );
    log.success(`Successfully verified ${yl(contract.contract)}!`);
  } catch (error) {
    log.error(`Failed to verify ${yl(contract.contract)}:`, error as Error);
    errors.push(contract.address);
  }
  log.emptyLine();
}

function getDeployedContract(contract: Contract): DeployedContract[] {
  if ("proxy" in contract && "implementation" in contract) {
    return [contract.proxy, contract.implementation];
  } else if ("implementation" in contract) {
    return [contract.implementation as DeployedContract];
  } else if ("contract" in contract && "address" in contract && "constructorArgs" in contract) {
    return [contract];
  }
  return [];
}
