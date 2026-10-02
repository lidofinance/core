import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Foundry 1.7.1 then estimates each transaction via RPC after its predecessor is mined.
export const RPC_GAS_ARGS = ["--skip-simulation"];

/** Keep pinned source, dependencies and compiler artifacts across fresh-chain deployments. */
export function prepareExternalProject(name: string, repository: string, ref: string, install: string[][]) {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`External project ${name} requires a commit SHA`);
  const directory = path.resolve(process.env.EXTERNAL_DEPLOY_CACHE || ".cache/external-deploy", name, ref);
  fs.mkdirSync(directory, { recursive: true });
  const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: directory, stdio: "inherit" });
  if (!fs.existsSync(path.join(directory, ".git"))) {
    run("git", ["init", "-q"]);
    run("git", ["fetch", "--depth=1", repository, ref]);
    run("git", ["checkout", "--detach", "FETCH_HEAD"]);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  if (head !== ref) throw new Error(`External project ${name}: expected ${ref}, got ${head}`);
  run("git", ["diff", "--exit-code"]);
  run("git", ["diff", "--cached", "--exit-code"]);
  console.log(JSON.stringify({ event: "external-project", name, ref, directory }));
  for (const [command, ...args] of install) run(command, args);
  return directory;
}
