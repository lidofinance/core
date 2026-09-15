import path from "node:path";

import { runScratchDeployPreflight } from "scripts/scratch/preflight";

import { applyDeploySteps, loadSteps, log } from "lib";

const runMigrations = async (stepsFile: string): Promise<void> => {
  const steps = loadSteps(stepsFile);
  console.log(`Loaded ${steps.length} migration steps from ${stepsFile}`);

  // Progress tracking (and thus RESUME support) applies to the scratch deploy
  // only: upgrade flows operate on real network state files that must not be
  // polluted with the completed-steps cursor.
  // Normalize so equivalent spellings (./scratch/steps.json, scratch//steps.json)
  // don't silently disable the preflight and RESUME progress tracking
  const isScratchDeploy = path.normalize(stepsFile).startsWith("scratch/");
  if (isScratchDeploy) {
    await runScratchDeployPreflight();
  }

  await applyDeploySteps(steps, { trackProgress: isScratchDeploy });
  process.exit(0);
};

// Execute the script if it's run directly
if (require.main === module) {
  const stepsFile = process.env.STEPS_FILE;
  if (!stepsFile) {
    log.error("Please provide a STEPS_FILE environment variable!");
    process.exit(1);
  }

  runMigrations(stepsFile).catch((error) => {
    log.error((error as Error).message);
    process.exit(1);
  });
}
