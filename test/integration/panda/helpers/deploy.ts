import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

import { Panda } from "lib/panda";
import { DeploymentState } from "lib/state-file";

// Public Hardhat development key; the network is created locally by Panda.start().
export const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export async function deployScratch(panda: Panda) {
  const status = await panda.status();
  assert.equal(BigInt(status.el.number), 0n);
  const [{ data: genesis }, { data: spec }] = await Promise.all([
    panda.beacon<{ data: Record<string, string> }>("/eth/v1/beacon/genesis"),
    panda.beacon<{ data: Record<string, string> }>("/eth/v1/config/spec"),
  ]);
  assert.equal(spec.PRESET_BASE, "mainnet");
  assert.equal(spec.GLOAS_FORK_EPOCH, "0");
  const file = path.join(panda.directory, "deployment.json");
  await panda.advanceSlots(1);
  for (let attempt = 0; ; attempt++) {
    try {
      assert.equal(await panda.rpc("eth_getTransactionReceipt", ["0x" + "00".repeat(32)]), null);
      break;
    } catch (error) {
      if (attempt >= 100 || !(error instanceof Error) || !error.message.includes("indexing is in progress"))
        throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await panda.setAutomine(true);
  const env = {
    ...process.env,
    NETWORK: "local-devnet",
    RUN_NETWORK: "local-devnet",
    MODE: "scratch",
    UPGRADE: "false",
    AUTO_FEE: "false",
    RPC_URL: panda.url,
    LOCAL_RPC_URL: panda.url,
    LOCAL_DEVNET_CHAIN_ID: "1337",
    LOCAL_DEVNET_PK: PRIVATE_KEY,
    DEPLOYER,
    GENESIS_TIME: genesis.genesis_time,
    GENESIS_FORK_VERSION: genesis.genesis_fork_version,
    SLOTS_PER_EPOCH: "32",
    DEPOSIT_CONTRACT: spec.DEPOSIT_CONTRACT_ADDRESS,
    GAS_PRIORITY_FEE: "1",
    GAS_MAX_FEE: "10",
    GAS_LIMIT: "",
    NETWORK_STATE_FILE: file,
    SCRATCH_DEPLOY_CONFIG: "scripts/scratch/deploy-params-panda.toml",
    STEPS_FILE: "scratch/steps.json",
    AUTO_CONFIRM: "true",
    ALLOW_SKIP_STEPS: "false",
    SKIP_INTERFACES_CHECK: "true",
    SKIP_CONTRACT_SIZE: "true",
    SKIP_GAS_REPORT: "true",
    SKIP_LINT_SOLIDITY: "true",
    HUSKY: "0",
    FORCE_COLOR: "0",
    FOUNDRY_THREADS: "2",
  } as unknown as NodeJS.ProcessEnv;
  const log = createWriteStream(path.join(panda.directory, "deploy.log"));
  const started = performance.now();
  const child = spawn("yarn", ["deploy:scratch"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.pipe(log, { end: false });
  const result = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 900_000);
  const steps: string[] = [];
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      log.write(`${line.replaceAll(PRIVATE_KEY, "<PUBLIC_DEVELOPMENT_KEY>")}\n`);
      const clean = stripVTControlCharacters(line).trim();
      if (clean.startsWith("Applying migration:")) steps.push(clean.split("/scripts/").at(-1)!);
      if (!clean.startsWith("{")) continue;
      let event: { event?: string; executableAt: number };
      try {
        event = JSON.parse(clean);
      } catch {
        continue;
      }
      if (event.event === "scratch-vote-wait") {
        const current = await panda.status();
        const seconds = event.executableAt - Number(BigInt(current.el.timestamp));
        assert.ok(seconds >= 0 && seconds <= 600);
        await panda.advanceSlots(Math.ceil(seconds / 12));
      }
    }
    assert.equal(await result, 0, `Scratch deployment failed: ${panda.directory}/deploy.log`);
    const expected = JSON.parse(await readFile("scripts/scratch/steps.json", "utf8")).steps;
    assert.deepEqual(
      steps.map((step) => step.replace(/\.ts$/, "")),
      expected,
    );
    const state = JSON.parse(await readFile(file, "utf8")) as DeploymentState;
    return { state, file, elapsedSeconds: (performance.now() - started) / 1000, steps: steps.length };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
    log.end();
  }
}
