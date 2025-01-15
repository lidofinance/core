import { existsSync, readFileSync } from "node:fs";

/* Determines the forking configuration for Hardhat */
export function getHardhatForkingConfig() {
  const forkingUrl = process.env.HARDHAT_FORKING_URL || "";

  if (!forkingUrl) {
    // Scratch deploy, need to disable CSM
    process.env.INTEGRATION_ON_SCRATCH = "on";
    process.env.INTEGRATION_WITH_CSM = "off";
    return undefined;
  }

  return { url: forkingUrl };
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
