import fs from "node:fs";
import path from "node:path";

import { ethers } from "hardhat";
import { runScratchDeployPreflight } from "scripts/scratch/preflight";

import { isResumeEnabled } from "./env-flags";
import { log } from "./log";
import { networkStateFileExists, persistNetworkState, readNetworkState, Sk } from "./state-file";

class StepsFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`Steps file ${filePath} not found!`);
    this.name = "StepsFileNotFoundError";
  }
}

class MigrationFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`Migration file ${filePath} not found!`);
    this.name = "MigrationFileNotFoundError";
  }
}

class MigrationMainFunctionError extends Error {
  constructor(filePath: string) {
    super(`Migration file ${filePath} does not export a 'main' function!`);
    this.name = "MigrationMainFunctionError";
  }
}

const deployedSteps: string[] = [];

export { isDGDeploymentEnabled, isResumeEnabled } from "./env-flags";

function getCompletedStepsFromState(): string[] {
  if (!networkStateFileExists()) return [];
  const completed = readNetworkState()[Sk.scratchDeployCompletedSteps];
  return Array.isArray(completed) ? completed : [];
}

function markStepCompleted(step: string): void {
  const state = readNetworkState();
  const stored = state[Sk.scratchDeployCompletedSteps];
  const completed = Array.isArray(stored) ? stored : [];
  if (!completed.includes(step)) completed.push(step);
  state[Sk.scratchDeployCompletedSteps] = completed;
  persistNetworkState(state);
}

// A kept state file may describe a chain that no longer exists (e.g. the local node
// was restarted since the previous run); skipping steps would then leave the deploy
// pointing at dead addresses with no error until far downstream.
async function assertChainMatchesState(): Promise<void> {
  const locator = (readNetworkState()[Sk.lidoLocator] as { proxy?: { address?: unknown } } | undefined)?.proxy?.address;
  if (typeof locator !== "string") return; // previous run failed before the locator step: nothing cheap to probe
  if ((await ethers.provider.getCode(locator)) === "0x") {
    throw new Error(
      `RESUME is set, but the lidoLocator address ${locator} recorded in the state file has no code on-chain. ` +
        `The node was likely restarted since the previous run; unset RESUME to redeploy from scratch.`,
    );
  }
}

interface ApplyStepsOptions {
  mine?: boolean; // mine a block after each step (in-process hardhat doesn't auto-mine)
  trackProgress?: boolean; // record completed steps in the state file; enables RESUME
}

export async function applyDeploySteps(steps: string[], options: ApplyStepsOptions = {}) {
  const { mine = false, trackProgress = false } = options;

  if (steps.every((step) => deployedSteps.includes(step))) {
    return; // All steps have been deployed
  }

  const resume = trackProgress && isResumeEnabled();
  const completedInState = resume ? getCompletedStepsFromState() : [];
  if (resume && completedInState.length > 0) {
    log(`RESUME is set: ${completedInState.length} step(s) already completed according to the state file`);
    await assertChainMatchesState();
  }

  for (const step of steps) {
    if (resume && completedInState.includes(step)) {
      log(`Skipping ${step} (already completed; RESUME is set)`);
      deployedSteps.push(step);
      continue;
    }

    const migrationFile = resolveMigrationFile(step);

    await applyMigrationScript(migrationFile);
    // Record completion before the mine: the step's txs are already applied, and a
    // transient RPC failure on evm_mine must not cause a non-idempotent re-run on RESUME
    if (trackProgress) {
      markStepCompleted(step);
    }
    if (mine) {
      await ethers.provider.send("evm_mine", []); // Persist the state after each step
    }

    deployedSteps.push(step);
  }
}

export async function deployUpgrade(networkName: string, stepsFile: string): Promise<void> {
  // Hardhat network is a fork of mainnet so we need to use the mainnet-fork steps
  if (networkName === "hardhat") {
    networkName = "mainnet-fork";
  }

  try {
    const steps = loadSteps(stepsFile);
    await applyDeploySteps(steps, { mine: true });
  } catch (error) {
    if (error instanceof StepsFileNotFoundError) {
      log.warning(`Upgrade steps not found in ${stepsFile}, assuming the protocol is already deployed`);
    } else {
      log.error("Upgrade failed:", (error as Error).message);
    }
  }
}

export async function deployScratchProtocol(): Promise<void> {
  const stepsFile = process.env.STEPS_FILE || "scratch/steps.json";
  const steps = loadSteps(stepsFile);

  // getProtocolContext() calls this for every MODE=scratch test file; once the steps
  // are deployed (applyDeploySteps memo) the preflight would be pure repeated overhead
  if (steps.every((step) => deployedSteps.includes(step))) {
    return;
  }

  await runScratchDeployPreflight();

  await applyDeploySteps(steps, { mine: true, trackProgress: true });
}

type StepsFile = {
  steps: string[];
};

export const loadSteps = (stepsFile: string): string[] => {
  const stepsPath = path.resolve(process.cwd(), `scripts/${stepsFile}`);
  if (!fs.existsSync(stepsPath)) {
    throw new StepsFileNotFoundError(stepsPath);
  }

  return (JSON.parse(fs.readFileSync(stepsPath, "utf8")) as StepsFile).steps;
};

export const resolveMigrationFile = (step: string): string => {
  const migrationFile = path.resolve(process.cwd(), `scripts/${step}.ts`);
  if (!fs.existsSync(migrationFile)) {
    throw new MigrationFileNotFoundError(migrationFile);
  }

  return migrationFile;
};

/**
 * Executes a migration script.
 * @param {string} migrationFile - The path to the migration file.
 * @throws {Error} If the migration file doesn't export a 'main' function or if any error occurs during migration.
 */
export async function applyMigrationScript(migrationFile: string): Promise<void> {
  const fullPath = path.resolve(migrationFile);
  const { main } = await import(fullPath);

  if (typeof main !== "function") {
    throw new MigrationMainFunctionError(migrationFile);
  }

  try {
    log.scriptStart(migrationFile);
    await main();
    log.scriptFinish(migrationFile);
  } catch (error) {
    log.error("Migration failed:", error as Error);
    process.exit(1);
  }
}
