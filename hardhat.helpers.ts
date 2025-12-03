import { existsSync, readFileSync } from "node:fs";

import { HardhatNetworkForkingUserConfig } from "hardhat/types";

export function getMode() {
  return process.env.MODE || "scratch";
}

/* Determines the forking configuration for Hardhat */
export function getHardhatForkingConfig() {
  const mode = getMode();

  if (mode === "scratch") {
    process.env.INTEGRATION_WITH_CSM = "off";
    return undefined;
  }

  if (mode === "forking") {
    const url = process.env.RPC_URL || "";
    if (!url) {
      throw new Error("RPC_URL must be set when MODE=forking");
    }

    const config: HardhatNetworkForkingUserConfig = { url };
    const block = process.env.FORKING_BLOCK_NUMBER;

    if (block) {
      const blockNumber = Number(block);
      if (!blockNumber || blockNumber <= 0) {
        throw new Error(`Invalid FORKING_BLOCK_NUMBER: ${block}`);
      }
      config.blockNumber = blockNumber;
    }
    return config;
  }

  throw new Error("MODE must be either 'scratch' or 'forking'");
}

// TODO: this plaintext accounts.json private keys management is a subject
//       of rework to a solution with the keys stored encrypted
export function loadAccounts(networkName: string) {
  const accountsPath = "./accounts.json";

  if (!existsSync(accountsPath)) {
    return [];
  }

  const content = JSON.parse(readFileSync(accountsPath, "utf-8"));
  if (!content.eth) {
    return [];
  }

  return content.eth[networkName] || [];
}
