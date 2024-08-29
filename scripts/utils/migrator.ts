import path from "path";

import { applyMigrationScript, log } from "lib";

// Execute the script if it's run directly
if (require.main === module) {
  const step = process.env.STEP;
  if (!step) {
    log.error("Please provide a STEP environment variable!");
    process.exit(1);
  }

  const migrationFile = path.resolve(process.cwd(), `scripts/${step}`);

  applyMigrationScript(migrationFile)
    .then(() => process.exit(0))
    .catch((error) => {
      log.error("Migration failed:", error);
      process.exit(1);
    });
}
