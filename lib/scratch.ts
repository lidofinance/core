import path from "node:path";

import { ethers } from "hardhat";

import { log } from "./log";
import { resetStateFile } from "./state-file";

export async function deployScratchProtocol(networkName: string): Promise<void> {
  await resetStateFile(networkName);

  const steps = [
    "scratch/steps/00-populate-deploy-artifact-from-env",
    "scratch/steps/01-deploy-deposit-contract",
    "scratch/steps/02-deploy-aragon-env",
    "scratch/steps/03-deploy-template-and-app-bases",
    "scratch/steps/04-register-ens-domain",
    "scratch/steps/05-deploy-apm",
    "scratch/steps/06-create-app-repos",
    "scratch/steps/07-deploy-dao",
    "scratch/steps/08-issue-tokens",
    "scratch/steps/09-deploy-non-aragon-contracts",
    "scratch/steps/10-gate-seal",
    "scratch/steps/11-finalize-dao",
    "scratch/steps/12-initialize-non-aragon-contracts",
    "scratch/steps/13-grant-roles",
    "scratch/steps/14-plug-curated-staking-module",
    "scratch/steps/15-transfer-roles",
  ];

  for (const step of steps) {
    const migrationFile = path.resolve(process.cwd(), `scripts/${step}`);
    try {
      await applyMigrationScript(migrationFile);

      await ethers.provider.send("evm_mine", []); // Persist the state after each step
    } catch (error) {
      log.error("Migration failed:", error as Error);
    }
  }
}

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
