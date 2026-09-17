import fs from "node:fs";
import path from "node:path";

import { getAddress, HDNodeWallet, Wallet } from "ethers";
import { HttpNetworkAccountsConfig } from "hardhat/types";

// Only process/runtime settings needed by git, Corepack and Hardhat. In particular,
// don't inherit unrelated RPC URLs, explorer tokens, private keys or NODE_OPTIONS.
export function siLidityToolingEnv(parent: Record<string, unknown> = process.env): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "LANG",
    "LC_ALL",
    "COREPACK_HOME",
    "XDG_CACHE_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ]) {
    if (typeof parent[key] === "string") env[key] = parent[key];
  }
  env.CI = "true";
  return env;
}

// Upstream only needs the selected deployer, not every private key in accounts.json.
export function siLiditySignerAccounts(accounts: HttpNetworkAccountsConfig, deployer: string): "remote" | string[] {
  if (accounts === "remote") return accounts;
  const expected = getAddress(deployer);
  if (Array.isArray(accounts)) {
    const key = accounts.find((value) => new Wallet(value).address === expected);
    if (key) return [key];
  } else {
    const root = HDNodeWallet.fromPhrase(accounts.mnemonic, accounts.passphrase, accounts.path);
    for (let i = accounts.initialIndex; i < accounts.initialIndex + accounts.count; i++) {
      const wallet = root.deriveChild(i);
      if (wallet.address === expected) return [wallet.privateKey];
    }
  }
  throw new Error("si-lidity selected deployer is absent from the configured accounts");
}

export function requireSiLidityArchive(directory: string, sourceRevision?: string, deploymentStarted?: boolean): void {
  if (!fs.existsSync(directory) || (sourceRevision && !fs.existsSync(path.join(directory, "repo/.git")))) {
    throw new Error(
      `si-lidity retained checkout/journal is missing at ${directory}; restore the archived directory before retrying to avoid duplicate deployments`,
    );
  }
  if (deploymentStarted && !fs.existsSync(path.join(directory, "repo/ignition/deployments/scratch/journal.jsonl"))) {
    throw new Error(
      "si-lidity retained Ignition journal is missing after deployment started; restore it or reconcile transactions before retrying",
    );
  }
}

export function assertSiLidityVerificationSupported(env: { VERIFY_ON_EXPLORER?: string } = process.env): void {
  const value = env.VERIFY_ON_EXPLORER?.trim().toLowerCase();
  if (value && value !== "false" && value !== "0") {
    throw new Error(
      "si-lidity's upstream Hardhat 3 preview does not support Ignition explorer verification. Set SI_LIDITY_DEPLOYMENT_ENABLED=false when VERIFY_ON_EXPLORER is enabled, or deploy the helpers separately with explorer verification disabled.",
    );
  }
}
