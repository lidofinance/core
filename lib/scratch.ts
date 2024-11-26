import fs from "node:fs";
import path from "node:path";

import { ethers } from "hardhat";

import { log } from "./log";
import { resetStateFile } from "./state-file";

const deployedSteps: string[] = [];

async function applySteps(steps: string[]) {
  if (steps.every((step) => deployedSteps.includes(step))) {
    return; // All steps have been deployed
  }

  for (const step of steps) {
    const migrationFile = resolveMigrationFile(step);

    await applyMigrationScript(migrationFile);
    await ethers.provider.send("evm_mine", []); // Persist the state after each step

    deployedSteps.push(step);
  }
}

export async function deployUpgrade(networkName: string): Promise<void> {
  // Hardhat network is a fork of mainnet so we need to use the mainnet-fork steps
  if (networkName === "hardhat") {
    networkName = "mainnet-fork";
  }

  try {
    const stepsFile = `upgrade/steps-${networkName}.json`;
    const steps = loadSteps(stepsFile);

    await applySteps(steps);
  } catch (error) {
    log.error("Upgrade failed:", (error as Error).message);
    log.warning("Upgrade steps not found, assuming the protocol is already deployed");
  }
}

export async function deployScratchProtocol(networkName: string): Promise<void> {
  const stepsFile = process.env.STEPS_FILE || "scratch/steps.json";
  const steps = loadSteps(stepsFile);

  await resetStateFile(networkName);
  await applySteps(steps);
}

type StepsFile = {
  steps: string[];
};

export const loadSteps = (stepsFile: string): string[] => {
  const stepsPath = path.resolve(process.cwd(), `scripts/${stepsFile}`);
  if (!fs.existsSync(stepsPath)) {
    throw new Error(`Steps file ${stepsPath} not found!`);
  }

  return (JSON.parse(fs.readFileSync(stepsPath, "utf8")) as StepsFile).steps;
};

export const resolveMigrationFile = (step: string): string => {
  const migrationFile = path.resolve(process.cwd(), `scripts/${step}.ts`);
  if (!fs.existsSync(migrationFile)) {
    throw new Error(`Migration file ${migrationFile} not found!`);
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
    throw new Error(`Migration file ${migrationFile} does not export a 'main' function!`);
  }

  try {
    log.scriptStart(migrationFile);
    await main();
    log.scriptFinish(migrationFile);
  } catch (error) {
    log.error("Migration failed:", error as Error);
    throw error;
  }
}
