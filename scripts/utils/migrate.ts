import { applyMigrationScript, loadSteps, log, resolveMigrationFile } from "lib";

const runMigrations = async (stepsFile: string): Promise<void> => {
  const steps = loadSteps(stepsFile);
  for (const step of steps) {
    const migrationFile = resolveMigrationFile(step);
    await applyMigrationScript(migrationFile);
  }
  process.exit(0);
};

// Execute the script if it's run directly
if (require.main === module) {
  const stepsFile = process.env.STEPS_FILE;
  if (!stepsFile) {
    log.error("Please provide a STEPS_FILE environment variable!");
    process.exit(1);
  }

  runMigrations(stepsFile).catch(() => process.exit(1));
}
