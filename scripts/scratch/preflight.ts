import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ethers } from "hardhat";
import { readScratchParameters, ScratchParameters, scratchParametersToDeploymentState } from "scripts/utils/scratch";

import { isDGDeploymentEnabled, isResumeEnabled } from "lib/env-flags";
import { log } from "lib/log";
import { networkStateFileExists, readNetworkState } from "lib/state-file";

import { assertNoDevCommitteesOnPublicChain, DG_SUBMODULE_DIR, resolveDgForgeRpcUrl } from "./dg-checks";

const SEPOLIA_CHAIN_ID = 11155111;
const SEPOLIA_GENESIS_FORK_VERSION = "0x90000069";

// State file paths that step 0000 legitimately overrides from env vars after the
// reset, so a TOML-vs-state difference there is expected, not stale-params drift
const ENV_OVERRIDDEN_STATE_PATHS = [
  "chainSpec",
  "deployer",
  "gateSeal.factoryAddress",
  "withdrawalQueueERC721.deployParameters.baseUri",
  "depositSecurityModule.address",
  "depositSecurityModule.deployParameters.usePredefinedAddressInstead",
];

// Collects dotted paths where the freshly TOML-derived state differs from the kept one.
// Only paths present in the fresh state are compared: addresses and other keys added
// by completed steps are not divergence.
function collectDivergedPaths(fresh: unknown, current: unknown, prefix: string, out: string[]): void {
  if (fresh !== null && typeof fresh === "object" && !Array.isArray(fresh)) {
    for (const [key, value] of Object.entries(fresh)) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      collectDivergedPaths(value, (current as Record<string, unknown> | undefined)?.[key], childPrefix, out);
    }
  } else if (JSON.stringify(fresh) !== JSON.stringify(current)) {
    out.push(prefix);
  }
}

function findResumeParamsDivergence(params: ScratchParameters): string[] {
  const fresh = scratchParametersToDeploymentState(params);
  const current = readNetworkState();
  const diverged: string[] = [];
  collectDivergedPaths(fresh, current, "", diverged);
  return diverged.filter((p) => !ENV_OVERRIDDEN_STATE_PATHS.some((skip) => p === skip || p.startsWith(`${skip}.`)));
}

// Validates everything the 20 deploy steps will need *before* any gas is spent.
// Without this, a missing forge binary or RPC_URL surfaces only at step 0160 —
// the last step, after the whole protocol (~120M gas) is already deployed.
// All findings are collected and reported together so a misconfigured
// environment is fixed in one iteration, not one variable at a time.
export async function runScratchDeployPreflight(): Promise<void> {
  log("Running scratch deploy preflight checks");
  const errors: string[] = [];

  // --- Environment variables -------------------------------------------------
  const deployer = process.env.DEPLOYER;
  if (!deployer) {
    errors.push("DEPLOYER is not set");
  } else {
    try {
      ethers.getAddress(deployer);
    } catch {
      errors.push(`DEPLOYER is not a valid address: ${deployer}`);
    }
  }

  const genesisTime = process.env.GENESIS_TIME;
  if (!genesisTime) {
    errors.push("GENESIS_TIME is not set");
  } else if (!/^\d+$/.test(genesisTime.trim()) || parseInt(genesisTime) <= 0) {
    errors.push(`GENESIS_TIME must be a positive integer (beacon chain genesis timestamp), got: ${genesisTime}`);
  }

  const genesisForkVersion = process.env.GENESIS_FORK_VERSION;
  if (genesisForkVersion && !/^0x[0-9a-fA-F]{8}$/.test(genesisForkVersion)) {
    errors.push(`GENESIS_FORK_VERSION must be a 4-byte hex string like 0x00000000, got: ${genesisForkVersion}`);
  }

  for (const name of ["DEPOSIT_CONTRACT", "GATE_SEAL_FACTORY", "DSM_PREDEFINED_ADDRESS"]) {
    const value = process.env[name];
    if (!value) continue;
    try {
      ethers.getAddress(value);
    } catch {
      errors.push(`${name} is set but is not a valid address: ${value}`);
    }
  }

  // --- Deploy parameters TOML (existence + Zod schema) ------------------------
  let params: ScratchParameters | undefined;
  try {
    params = readScratchParameters();
  } catch (e) {
    errors.push(`Deploy parameters are invalid: ${(e as Error).message}`);
  }

  // --- Resume coherence: the kept state file must still match the TOML --------
  // On RESUME the state file (with the deploy params baked in at the original run)
  // is kept, so TOML edits made between runs are silently ignored by the remaining
  // parameterized steps — warn so the operator isn't surprised.
  if (params && isResumeEnabled() && networkStateFileExists()) {
    try {
      const diverged = findResumeParamsDivergence(params);
      if (diverged.length > 0) {
        log.warning(
          `RESUME is set, so the existing state file is kept, but the deploy params TOML now differs from the ` +
            `values baked into it: ${diverged.join(", ")}. The TOML changes will be IGNORED by the remaining ` +
            `steps; unset RESUME for a clean deploy if they must apply.`,
        );
      }
    } catch (e) {
      log.warning(`Could not compare deploy params against the kept state file: ${(e as Error).message}`);
    }
  }

  // --- Chain coherence ---------------------------------------------------------
  let chainId: number | undefined;
  try {
    chainId = Number((await ethers.provider.getNetwork()).chainId);
  } catch (e) {
    errors.push(`Cannot reach the RPC node to read chainId: ${(e as Error).message}`);
  }
  if (chainId === SEPOLIA_CHAIN_ID && genesisForkVersion?.toLowerCase() !== SEPOLIA_GENESIS_FORK_VERSION) {
    log.warning(
      `chainId is Sepolia (${SEPOLIA_CHAIN_ID}) but GENESIS_FORK_VERSION is ` +
        `${genesisForkVersion ?? "unset (defaults to 0x00000000)"} instead of ${SEPOLIA_GENESIS_FORK_VERSION}; ` +
        `the deposit contract branch in step 0010 keys off the chainId, but oracle/CL tooling reads the fork version`,
    );
  }

  // --- Dual governance prerequisites (step 0160 needs all of these) -----------
  if (isDGDeploymentEnabled()) {
    if (params && !params.dualGovernance) {
      errors.push(
        "Scratch deploy params have no [dualGovernance] section. Add one (see deploy-params-testnet.toml) " +
          "or set DG_DEPLOYMENT_ENABLED=false to skip DG.",
      );
    }

    try {
      resolveDgForgeRpcUrl();
    } catch (e) {
      errors.push((e as Error).message);
    }

    if (!fs.existsSync(path.join(DG_SUBMODULE_DIR, "foundry.toml"))) {
      errors.push(
        `dual-governance submodule is not populated at ${DG_SUBMODULE_DIR}. ` +
          "Run: git submodule update --init --recursive",
      );
    }

    const forge = spawnSync("forge", ["--version"], { stdio: "ignore" });
    if (forge.error || forge.status !== 0) {
      errors.push("`forge` is not available in PATH (required for the DG deploy step). Install foundry.");
    }

    if (params?.dualGovernance && chainId !== undefined) {
      try {
        assertNoDevCommitteesOnPublicChain(params.dualGovernance, chainId);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Scratch deploy preflight failed:\n  - ${errors.join("\n  - ")}`);
  }

  // --- Non-fatal: deployer balance (some flows fund the deployer later) -------
  if (deployer && chainId !== undefined) {
    try {
      const balance = await ethers.provider.getBalance(deployer);
      if (balance === 0n) {
        log.warning(`Deployer ${deployer} has zero balance on chainId=${chainId}`);
      }
    } catch {
      // balance check is best-effort only
    }
  }

  log.success("Preflight checks passed");
}
