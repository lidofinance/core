import { existsSync, readFileSync } from "node:fs";

/* Determines the forking configuration for Hardhat */
export function getHardhatForkingConfig() {
  const mode = process.env.MODE || "scratch";

  switch (mode) {
    case "scratch":
      process.env.INTEGRATION_WITH_CSM = "off";
      return undefined;

    case "forking":
      if (!process.env.FORK_RPC_URL) {
        throw new Error("FORK_RPC_URL must be set when MODE=forking");
      }
      return { url: process.env.FORK_RPC_URL };

    default:
      throw new Error("MODE must be either 'scratch' or 'forking'");
  }
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
