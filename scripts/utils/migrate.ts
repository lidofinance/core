import { log } from "lib/log.js";
import { applyMigrationScript, loadSteps, resolveMigrationFile } from "lib/scratch.js";

const runMigrations = async (stepsFile: string): Promise<void> => {
  const steps = loadSteps(stepsFile);
  console.log(`Loaded ${steps.length} migration steps from ${stepsFile}`);
  for (const step of steps) {
    const migrationFile = resolveMigrationFile(step);
    console.log(`Applying migration: ${migrationFile}`);
    await applyMigrationScript(migrationFile);
  }
  process.exit(0);
};

const stepsFile = process.env.STEPS_FILE;
if (!stepsFile) {
  log.error("Please provide a STEPS_FILE environment variable!");
  process.exit(1);
}

await runMigrations(stepsFile).catch(() => process.exit(1));
