import fs from "node:fs/promises";

import { runCommand } from "./subprocess";

const DG_REPOSITORY_URL = "https://github.com/lidofinance/dual-governance.git";
const DG_REPOSITORY_BRANCH = "feature/scratch-deploy-support2"; // TODO: use release branch
const DG_INSTALL_DIR = `${process.cwd()}/dg`;

async function main() {
  console.log("Delete DG folder", DG_INSTALL_DIR);
  await fs.rm(DG_INSTALL_DIR, { force: true, recursive: true });

  console.log("Clone DG repo to", DG_INSTALL_DIR);
  await runCommand(
    `git clone --branch ${DG_REPOSITORY_BRANCH} --single-branch ${DG_REPOSITORY_URL} ${DG_INSTALL_DIR}`,
    process.cwd(),
  );

  console.log("Building DualGovernance contracts");
  await runForgeBuild(DG_INSTALL_DIR);

  console.log("Running unit tests");
  await runUnitTests(DG_INSTALL_DIR);
}

async function runForgeBuild(workingDirectory: string) {
  await runCommand("forge build", workingDirectory);
}

async function runUnitTests(workingDirectory: string) {
  await runCommand("npm run test:unit", workingDirectory);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
