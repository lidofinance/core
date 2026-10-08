import { spawnSync } from "child_process";

// execFileSync includes arguments (including credentials) in its thrown Error.
// Report only the executable and termination status, never args or raw errors.
export function runExternal(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new Error(`External ${command} process could not start (${code})`);
  }
  if (result.status !== 0) {
    throw new Error(`External ${command} process failed (status ${result.status}, signal ${result.signal})`);
  }
}

export function explorerVerificationArgs(
  env: { VERIFY_ON_EXPLORER?: string; ETHERSCAN_API_KEY?: string } = process.env,
): string[] {
  const enabled = env.VERIFY_ON_EXPLORER?.trim().toLowerCase();
  if (enabled === undefined || enabled === "" || enabled === "false" || enabled === "0") return [];
  if (enabled !== "true" && enabled !== "1") {
    throw new Error("VERIFY_ON_EXPLORER must be true, false, 1, or 0");
  }
  if (!env.ETHERSCAN_API_KEY) {
    throw new Error("Explorer verification requires ETHERSCAN_API_KEY");
  }
  return ["--verify", "--etherscan-api-key", env.ETHERSCAN_API_KEY];
}
