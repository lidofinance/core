import child_process from "node:child_process";
import fs from "node:fs/promises";
import util from "node:util";

async function main() {
  const dgDir = `${process.cwd()}/node_modules/@lido/dual-governance`;
  const gitmodulesPath = `${dgDir}/.gitmodules`;

  const gitmodulesExists = await checkFileExists(gitmodulesPath);
  if (!gitmodulesExists) {
    console.log(`.gitmodules file not found at ${gitmodulesPath}`);
    return;
  }

  console.log(`.gitmodules file found at ${gitmodulesPath}`);

  const gitmodulesFile = (await fs.readFile(gitmodulesPath)).toString().replaceAll(/\t/g, "");

  const submodules = parseGitmodules(gitmodulesFile);
  console.log(submodules);

  await fs.rm(`${dgDir}/lib`, { force: true, recursive: true });

  await cloneSubmodules(submodules);

  console.log("Building DualGovernance contracts");
  await runForgeBuild(dgDir);

  console.log("Running unit tests");
  await runUnitTests(dgDir);
}

type GitSubmodule = {
  path: string;
  url: string;
  branch?: string;
};

/**
 * @param {String} gitmodulesFile .gitmodules file content
 */
function parseGitmodules(gitmodulesFile: string) {
  const submoduleSectionRe = /\[submodule(\s+)('|")(.+)('|")\]([^\[]+)/gm;
  const submodulePropertyRe = /(path)(.+)|(url)(.+)|(branch)(.+)/g;
  const submodulesList = [...gitmodulesFile.matchAll(submoduleSectionRe)];
  const result: Record<string, GitSubmodule> = {};

  if (!submodulesList.length) {
    return result;
  }

  submodulesList.forEach((submoduleText) => {
    const item: GitSubmodule = {
      path: "",
      url: ""
    };
    const submodulePropertiesList = [...(submoduleText[5] || "").matchAll(submodulePropertyRe)];
    submodulePropertiesList.forEach((conf) => {
      const [key = "", value = ""] = (conf[0] ?? "").split("=");
      const pureKey = key.trim() as "path" | "url" | "branch";
      if (pureKey) {
        item[pureKey] = value.trim();
      }
    });
    result[item.path] = item;
  })
  return result;
}

async function cloneSubmodules(submodules: Record<string, GitSubmodule>) {
  for (const key of Object.keys(submodules)) {
    let branch = submodules[key].branch || "";
    if (branch.length && branch.indexOf("tag") != -1) {
      branch = branch.replace("tags/", "");
    }
    await runCommand(`git clone ${branch.length ? `--branch ${branch}` : ""} --single-branch ${submodules[key].url} ${process.cwd()}/node_modules/@lido/dual-governance/${submodules[key].path}`, process.cwd());
  }
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

async function checkFileExists(path: string) {
  return fs.access(path)
    .then(() => true)
    .catch(() => false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
