import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

import type { ChronixClient } from "@lidofinance/chronix-client";

import { DeploymentState } from "lib/state-file";

type BeaconResponse<T> = { data: T; execution_optimistic?: boolean };
type BeaconHead = BeaconResponse<{ canonical: boolean; root: string; header: { message: { slot: string } } }>;

// Public Hardhat development key; used only against the local Chronix network.
export const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * Check that the Chronix service exposes a fresh Gloas chain, then run the ordinary scratch
 * deployment on it. The run's logs and artifacts go to `.local/chronix/core-<id>/`.
 */
export async function deployScratch(chronix: ChronixClient) {
  const status = await chronix.status();
  assert.equal(status.profile, "gloas", "The verifier suite requires the Gloas profile");
  assert.equal(BigInt(status.el.number), 0n, "Chronix must start a fresh chain");
  assert.equal(status.slot, 0, "Chronix must start at genesis");
  assert.equal(status.automine, false, "The suite owns automine setup");
  const [head, { data: genesis }, { data: spec }] = await Promise.all([
    chronix.beacon<BeaconHead>("/eth/v1/beacon/headers/head"),
    chronix.beacon<BeaconResponse<Record<string, string>>>("/eth/v1/beacon/genesis"),
    chronix.beacon<BeaconResponse<Record<string, string>>>("/eth/v1/config/spec"),
  ]);
  assert.equal(head.execution_optimistic, false, "CL head must not be optimistic");
  assert.equal(head.data.canonical, true, "CL head must be canonical");
  assert.equal(BigInt(head.data.header.message.slot), 0n, "CL must start at genesis");
  assert.equal(BigInt(genesis.genesis_time), BigInt(status.el.timestamp), "EL/CL genesis time must match");
  assert.equal(spec.PRESET_BASE, "mainnet");
  assert.equal(spec.SECONDS_PER_SLOT, "12");
  assert.equal(
    BigInt(spec.DEPOSIT_CHAIN_ID),
    BigInt(await chronix.rpc<string>("eth_chainId")),
    "EL/CL chain ID must match",
  );
  assert.equal(spec.GLOAS_FORK_EPOCH, "0", "Gloas must be active from genesis");

  const directory = path.resolve(".local/chronix", `core-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "deployment.json");
  await chronix.advanceSlots(1);
  for (let attempt = 0; ; attempt++) {
    try {
      assert.equal(await chronix.rpc("eth_getTransactionReceipt", ["0x" + "00".repeat(32)]), null);
      break;
    } catch (error) {
      if (attempt >= 100 || !(error instanceof Error) || !error.message.includes("indexing is in progress"))
        throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await chronix.setAutomine(true);
  const env = {
    ...process.env,
    NETWORK: "local-devnet",
    RUN_NETWORK: "local-devnet",
    MODE: "scratch",
    UPGRADE: "false",
    AUTO_FEE: "false",
    RPC_URL: chronix.url,
    LOCAL_RPC_URL: chronix.url,
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
    SCRATCH_DEPLOY_CONFIG: "scripts/scratch/deploy-params-chronix.toml",
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
  const log = createWriteStream(path.join(directory, "deploy.log"));
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
        const current = await chronix.status();
        const seconds = event.executableAt - Number(BigInt(current.el.timestamp));
        assert.ok(seconds >= 0 && seconds <= 600);
        await chronix.advanceSlots(Math.ceil(seconds / 12));
      }
    }
    assert.equal(await result, 0, `Scratch deployment failed: ${directory}/deploy.log`);
    const expected = JSON.parse(await readFile("scripts/scratch/steps.json", "utf8")).steps;
    assert.deepEqual(
      steps.map((step) => step.replace(/\.ts$/, "")),
      expected,
    );
    const state = JSON.parse(await readFile(file, "utf8")) as DeploymentState;
    return { state, file, directory, elapsedSeconds: (performance.now() - started) / 1000, steps: steps.length };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
    log.end();
  }
}
