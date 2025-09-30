import child_process from "node:child_process";
import util from "node:util";

export async function runCommand(command: string, workingDirectory: string) {
  const exec = util.promisify(child_process.exec);

  try {
    const { stdout } = await exec(command, { cwd: workingDirectory });
    console.log("stdout:", stdout);
  } catch (error) {
    console.error(`Error running command ${command}`, `${error}`);
    throw error;
  }
}
