import { network, run } from "hardhat";
import {
  buildEDFDevnetVerificationPlan,
  verifyExecutionDelegationFrameworkDevnet,
} from "scripts/utils/edf-devnet-verification";

import { readNetworkState, Sk } from "lib";

const CORE_CONTRACTS = ["contracts/0.8.9/DepositSecurityModule.sol", "contracts/0.8.9/LidoLocator.sol"].join(",");

async function main() {
  if (network.name !== "local-devnet") {
    throw new Error(`EDF devnet verification requires local-devnet, got ${network.name}`);
  }

  const networkStateFile = process.env.NETWORK_STATE_FILE;
  if (!networkStateFile) throw new Error("NETWORK_STATE_FILE is required");

  const state = readNetworkState();
  buildEDFDevnetVerificationPlan(state);
  if (!state[Sk.depositSecurityModule]?.address) {
    throw new Error("DepositSecurityModule is missing in deployment state");
  }
  if (!state[Sk.lidoLocator]?.implementation?.address) {
    throw new Error("LidoLocator implementation is missing in deployment state");
  }

  await run("verify:deployed", {
    file: networkStateFile,
    only: CORE_CONTRACTS,
  });
  if (process.exitCode) throw new Error("Core devnet contract verification failed");

  await verifyExecutionDelegationFrameworkDevnet(state);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
