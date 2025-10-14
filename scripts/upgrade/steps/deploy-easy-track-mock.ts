import { ethers } from "hardhat";

import { VaultsAdapterMock } from "typechain-types";

import { loadContract } from "lib/contract";
import { deployWithoutProxy } from "lib/deploy";
import { log } from "lib/log";
import { Sk } from "lib/state-file";

const EVM_SCRIPT_EXECUTOR = process.env.EVM_SCRIPT_EXECUTOR as string;
if (!EVM_SCRIPT_EXECUTOR) {
  throw new Error("EVM_SCRIPT_EXECUTOR environment variable is not set");
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;

  const vaultsAdapterMock_ = await deployWithoutProxy(Sk.vaultsAdapter, "VaultsAdapterMock", deployer, [
    EVM_SCRIPT_EXECUTOR,
  ]);
  await vaultsAdapterMock_.waitForDeployment();

  log.success("Deployed VaultsAdapterMock", vaultsAdapterMock_.address);

  const vaultsAdapterMock = await loadContract<VaultsAdapterMock>("VaultsAdapterMock", vaultsAdapterMock_.address);

  // Check that there is a contract at vaultsAdapterMock.evmScriptExecutor
  const evmScriptExecutorAddress = await vaultsAdapterMock.evmScriptExecutor();
  const code = await ethers.provider.getCode(evmScriptExecutorAddress);
  if (code === "0x") {
    throw new Error(`No contract found at vaultsAdapterMock.evmScriptExecutor address: ${evmScriptExecutorAddress}`);
  }
}

main().catch((error) => {
  log.error(error);
  process.exitCode = 1;
});
