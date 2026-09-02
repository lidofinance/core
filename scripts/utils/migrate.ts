import { applyMigrationScript, loadSteps, log, resolveMigrationFile } from "#lib";

const runMigrations = async (migrationStepsFile: string): Promise<void> => {
  const steps = loadSteps(migrationStepsFile);
  console.log(`Loaded ${steps.length} migration steps from ${migrationStepsFile}`);
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
