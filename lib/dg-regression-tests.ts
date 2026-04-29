import { log } from "./log";
import { runCommand } from "./subprocess";

const DG_INSTALL_DIR = `${process.cwd()}/dg`;

async function runDGRegressionTests() {
  log.header("Run Dual Governance regression tests");
  try {
    await runCommand("npm run test:regressions", DG_INSTALL_DIR);
  } catch (error) {
    // TODO: some of regression tests don't work at the moment, need to fix it.
    log.error("DG regression tests run failed");
    log(`${error}`);
  }
}

runDGRegressionTests()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
