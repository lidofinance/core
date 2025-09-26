import child_process from "node:child_process";
import fs from "node:fs/promises";
import util from "node:util";

const DG_REPOSITORY_URL = "https://github.com/lidofinance/dual-governance.git";
const DG_REPOSITORY_BRANCH = "feature/scratch-deploy-support"; // TODO: use release branch
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

async function runCommand(command: string, workingDirectory: string) {
  const exec = util.promisify(child_process.exec);

  try {
    const { stdout } = await exec(command, { cwd: workingDirectory });
    console.log("stdout:", stdout);
  } catch (error) {
    console.error(`Error running command ${command}`, `${error}`);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
