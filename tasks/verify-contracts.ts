import fs from "node:fs/promises";
import path from "node:path";

import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { cy, log, yl } from "lib/log";

type DeployedContract = {
  contract: string;
  address: string;
  constructorArgs: unknown[];
};

type ProxyContract = {
  proxy: DeployedContract;
  implementation: DeployedContract;
};

type Contract = DeployedContract | ProxyContract;

type NetworkState = {
  deployer: string;
  [key: string]: Contract | string | number;
};

const errors = [] as string[];

task("verify:deployed", "Verifies deployed contracts based on state file").setAction(
  async (_: unknown, hre: HardhatRuntimeEnvironment) => {
    try {
      const network = hre.network.name;
      log("Verifying contracts for network:", network);

      const networkStateFile = `deployed-${network}.json`;
      const networkStateFilePath = path.resolve("./", networkStateFile);
      const data = await fs.readFile(networkStateFilePath, "utf8");
      const networkState = JSON.parse(data) as NetworkState;

      const deployedContracts = Object.values(networkState)
        .filter((contract): contract is Contract => typeof contract === "object")
        .flatMap(getDeployedContract);

      // Not using Promise.all to avoid logging messages out of order
      for (const contract of deployedContracts) {
        await verifyContract(contract, hre);
      }
    } catch (error) {
      log.error("Error verifying deployed contracts:", error as Error);
      throw error;
    }

    if (errors.length > 0) {
      log.error(`Failed to verify ${errors.length} contract(s):`, errors as string[]);
      process.exitCode = errors.length;
    }
  },
);

async function verifyContract(contract: DeployedContract, hre: HardhatRuntimeEnvironment) {
  const contractName = contract.contract.split("/").pop()?.split(".")[0];
  const verificationParams = {
    address: contract.address,
    constructorArguments: contract.constructorArgs,
    contract: `${contract.contract}:${contractName}`,
  };

  log.withArguments(
    `Verifying contract: ${yl(contract.contract)} at ${cy(contract.address)} with constructor args `,
    verificationParams.constructorArguments as string[],
  );

  try {
    await hre.run("verify:verify", verificationParams);
    log.success(`Successfully verified ${yl(contract.contract)}!`);
  } catch (error) {
    log.error(`Failed to verify ${yl(contract.contract)}:`, error as Error);
    errors.push(verificationParams.address);
  }
  log.emptyLine();
}

function getDeployedContract(contract: Contract): DeployedContract[] {
  if ("proxy" in contract && "implementation" in contract) {
    return [contract.proxy, contract.implementation];
  } else if ("contract" in contract && "address" in contract && "constructorArgs" in contract) {
    return [contract];
  }
  return [];
}
