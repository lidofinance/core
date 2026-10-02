import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export interface PandaStatus {
  id: string;
  profile: string;
  bake: string;
  bakeKey: string;
  slot: number;
  automine: boolean;
  el: { number: string; hash: string; timestamp: string };
}

export interface WarpOptions {
  mode: "honest" | "fast";
}

type BeaconResponse<T> = { data: T; version?: string; execution_optimistic?: boolean };
type BeaconHead = BeaconResponse<{ canonical: boolean; root: string; header: { message: { slot: string } } }>;
type ExecutionBlock = { number: string; hash: string; timestamp: string; parentHash: string };
type GloasBlock = BeaconResponse<{
  message: {
    slot: string;
    body: { signed_execution_payload_bid: { message: { block_hash: string; parent_block_hash: string } } };
  };
}>;
const endpoint = (value: string, name: string): string => {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), `${name} must be HTTP(S)`);
  assert.equal(url.pathname, "/", `${name} must be an API root`);
  assert.ok(
    !url.search && !url.hash && !url.username && !url.password,
    `${name} must be an API root without credentials`,
  );
  return url.origin;
};

/** Thin Node client: the Panda process owns Docker, EL/CL and protocol time. */
export class Panda {
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private genesisTime = 0n;
  private constructor(
    readonly root: string,
    readonly id: string,
    readonly directory: string,
    readonly profile: string,
    readonly bake: string,
    public url = "",
    public beaconUrl = "",
    readonly timeoutMs = 3_600_000,
  ) {}

  static async start({
    root = process.env.PANDA_ROOT,
    url = process.env.PANDA_URL,
    beaconUrl = process.env.PANDA_BEACON_URL,
    profile = "gloas",
    bake = process.env.PANDA_BAKE,
    output = ".local/panda",
    port = 0,
    timeoutMs = Number(process.env.PANDA_TIMEOUT_MS ?? 3_600_000),
  } = {}): Promise<Panda> {
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647, "Invalid timeoutMs");
    const id = `core-${randomUUID().slice(0, 8)}`;
    const beaconEndpoint = beaconUrl ? endpoint(beaconUrl, "PANDA_BEACON_URL") : "";
    if (url) {
      const controllerEndpoint = endpoint(url, "PANDA_URL");
      const directory = path.resolve(output, id);
      const connection = new Panda("", id, directory, profile, bake ?? "", controllerEndpoint, "", timeoutMs);
      const status = await connection.status();
      assert.match(status.id, /^[a-z0-9][a-z0-9-]{0,39}$/);
      assert.equal(status.profile, profile);
      if (bake) assert.equal(status.bake, bake);
      assert.match(status.bakeKey, /^[a-f0-9]{64}$/);
      const panda = new Panda(
        "",
        status.id,
        directory,
        profile,
        status.bake,
        controllerEndpoint,
        beaconEndpoint || controllerEndpoint,
        timeoutMs,
      );
      await panda.assertFreshGenesis(status);
      await mkdir(directory, { recursive: true });
      return panda;
    }
    assert.ok(root, "Set PANDA_ROOT for local startup or PANDA_URL for a running service");
    bake ??= "panda";
    const panda = new Panda(
      path.resolve(root),
      id,
      path.resolve(output, id),
      profile,
      bake,
      "",
      beaconEndpoint,
      timeoutMs,
    );
    await mkdir(panda.directory, { recursive: true });
    const log = createWriteStream(path.join(panda.directory, "network.log"));
    const child = spawn("deno", ["task", "up", "--profile", profile, "--bake", bake], {
      cwd: panda.root,
      env: {
        ...process.env,
        PANDA_ID: id,
        PANDA_PORT: String(port),
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    panda.child = child;
    child.stderr.pipe(log, { end: false });
    panda.exited = new Promise((resolve) =>
      child.once("close", () => {
        log.end();
        resolve();
      }),
    );
    try {
      panda.url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Panda startup timed out: ${panda.directory}`)), timeoutMs);
        createInterface({ input: child.stdout }).on("line", (line) => {
          log.write(`${line}\n`);
          let event: { event?: string; id?: string; url?: string };
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.event === "ready" && event.id === id && event.url) {
            clearTimeout(timer);
            resolve(event.url);
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`Panda exited (${code}): ${panda.directory}`));
        });
      });
      const status = await panda.status();
      panda.beaconUrl ||= panda.url;
      assert.equal(status.id, id);
      assert.equal(status.profile, profile);
      assert.equal(status.bake, bake);
      await panda.assertFreshGenesis(status);
      return panda;
    } catch (error) {
      await panda.close();
      throw error;
    }
  }

  async rpc<T>(method: string, params: unknown[] = [], control = false): Promise<T> {
    const response = await fetch(this.url + (control ? "/control" : ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    assert.ok(response.ok, `${method}: Panda HTTP ${response.status}: ${text.slice(0, 4096)}`);
    const body = JSON.parse(text) as { result: T; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  async beacon<T>(route: string, body?: unknown): Promise<T> {
    return this.beaconRequest(this.beaconUrl, route, body);
  }

  private async beaconRequest<T>(base: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(base + route, {
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    assert.ok(response.ok, `Beacon ${route}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async assertFreshGenesis(status: PandaStatus): Promise<void> {
    assert.equal(BigInt(status.el.number), 0n, "Panda must start a fresh chain");
    assert.equal(status.slot, 0, "Panda must start at genesis");
    assert.equal(status.automine, false, "The suite owns automine setup");
    const head = await this.beacon<BeaconHead>("/eth/v1/beacon/headers/head");
    assert.equal(head.execution_optimistic, false, "CL head must not be optimistic");
    assert.equal(head.data.canonical, true, "CL head must be canonical");
    assert.equal(BigInt(head.data.header.message.slot), 0n, "CL must start at genesis");
    assert.match(head.data.root, /^0x[0-9a-f]{64}$/i);
    if (this.beaconUrl !== this.url) {
      const ownHead = await this.beaconRequest<BeaconHead>(this.url, "/eth/v1/beacon/headers/head");
      assert.equal(head.data.root, ownHead.data.root, "Panda and native CL must report the same Beacon head");
    }
    const genesis = await this.beacon<BeaconResponse<{ genesis_time: string }>>("/eth/v1/beacon/genesis");
    this.genesisTime = BigInt(genesis.data.genesis_time);
    assert.equal(this.genesisTime, BigInt(status.el.timestamp), "EL/CL genesis time must match");
    const spec = await this.beacon<BeaconResponse<Record<string, string>>>("/eth/v1/config/spec");
    assert.equal(spec.data.PRESET_BASE, "mainnet");
    assert.equal(spec.data.SECONDS_PER_SLOT, "12");
    assert.equal(
      BigInt(spec.data.DEPOSIT_CHAIN_ID),
      BigInt(await this.rpc<string>("eth_chainId")),
      "EL/CL chain ID must match",
    );
    if (this.profile === "gloas") assert.equal(spec.data.GLOAS_FORK_EPOCH, "0", "Gloas must be active from genesis");
  }

  /** Bind a captured Gloas Beacon root to its real, canonical EL payload. */
  async assertExecution(blockRoot: string) {
    assert.equal(this.profile, "gloas", "Execution proof checks require the Gloas verifier profile");
    assert.match(blockRoot, /^0x[0-9a-f]{64}$/i);
    const block = await this.beacon<GloasBlock>(`/eth/v2/beacon/blocks/${blockRoot}`);
    assert.equal(block.version, "gloas", "Expected a Gloas block");
    assert.equal(block.execution_optimistic, false, "CL block must not be optimistic");
    const envelope = await this.beacon<
      BeaconResponse<{
        message: {
          beacon_block_root: string;
          payload: {
            slot_number: string;
            block_hash: string;
            parent_hash: string;
            block_number: string;
            timestamp: string;
          };
        };
      }>
    >(`/eth/v1/beacon/execution_payload_envelopes/${blockRoot}`);
    assert.equal(envelope.version, "gloas", "Expected a Gloas envelope");
    assert.equal(envelope.execution_optimistic, false, "CL envelope must not be optimistic");
    assert.equal(envelope.data.message.beacon_block_root, blockRoot, "Envelope must bind the captured Beacon root");
    const payload = envelope.data.message.payload;
    const bid = block.data.message.body.signed_execution_payload_bid.message;
    assert.equal(payload.slot_number, block.data.message.slot, "Gloas envelope slot must match the block");
    assert.equal(payload.block_hash, bid.block_hash, "Gloas bid/envelope execution hash must match");
    assert.equal(payload.parent_hash, bid.parent_block_hash, "Gloas bid/envelope execution parent must match");
    assert.equal(
      BigInt(payload.timestamp),
      this.genesisTime + BigInt(payload.slot_number) * 12n,
      "Invalid CL slot timestamp",
    );
    const number = `0x${BigInt(payload.block_number).toString(16)}`;
    const el = await this.rpc<ExecutionBlock | null>("eth_getBlockByNumber", [number, false]);
    assert.ok(el, "CL payload must exist in canonical EL history");
    assert.equal(el.hash, payload.block_hash, "EL/CL execution hash must match");
    assert.equal(el.parentHash, payload.parent_hash, "EL/CL execution parent must match");
    assert.equal(BigInt(el.number), BigInt(payload.block_number), "EL/CL block number must match");
    assert.equal(BigInt(el.timestamp), BigInt(payload.timestamp), "EL/CL execution timestamp must match");
    return { blockRoot, slot: payload.slot_number, executionHash: el.hash, executionNumber: el.number };
  }

  /** Gloas finalizes the checkpoint's execution parent, not its own payload. */
  async finalized() {
    assert.equal(this.profile, "gloas", "Finality checks require the Gloas verifier profile");
    const response = await this.beacon<BeaconResponse<{ finalized: { epoch: string; root: string } }>>(
      "/eth/v1/beacon/states/head/finality_checkpoints",
    );
    assert.equal(response.execution_optimistic, false, "CL finality must not be optimistic");
    const checkpoint = response.data.finalized;
    if (BigInt(checkpoint.epoch) === 0n) return null;
    assert.match(checkpoint.root, /^0x[0-9a-f]{64}$/i);
    const block = await this.beacon<GloasBlock>(`/eth/v2/beacon/blocks/${checkpoint.root}`);
    assert.equal(block.version, "gloas", "Expected a Gloas checkpoint");
    assert.equal(block.execution_optimistic, false, "CL checkpoint must not be optimistic");
    assert.ok(
      BigInt(block.data.message.slot) <= BigInt(checkpoint.epoch) * 32n,
      "Checkpoint block exceeds its epoch boundary",
    );
    const el = await this.rpc<ExecutionBlock | null>("eth_getBlockByNumber", ["finalized", false]);
    assert.ok(el, "EL must expose a finalized block");
    assert.equal(
      el.hash,
      block.data.message.body.signed_execution_payload_bid.message.parent_block_hash,
      "Gloas finalized execution must equal the checkpoint execution parent",
    );
    return { epoch: checkpoint.epoch, root: checkpoint.root, executionHash: el.hash, executionNumber: el.number };
  }

  status(): Promise<PandaStatus> {
    return this.rpc("status", [], true);
  }
  advanceSlots(count: number): Promise<void> {
    return this.rpc("advanceSlots", [count], true);
  }
  advanceTo(timestamp: number, options?: WarpOptions): Promise<void> {
    return this.rpc("advanceTo", options ? [timestamp, options] : [timestamp], true);
  }
  setAutomine(enabled: boolean): Promise<void> {
    return this.rpc("setAutomine", [enabled], true);
  }

  /** Import an EIP-2335 key so newly deposited validators can perform their duties. */
  async importValidator(keystore: string, password: string): Promise<void> {
    await this.rpc("importValidator", [keystore, password], true);
  }

  async exitValidator(pubkey: string): Promise<void> {
    assert.match(pubkey, /^0x[0-9a-f]{96}$/i);
    await this.rpc("exitValidator", [pubkey], true);
  }

  close(): Promise<void> {
    if (!this.child || this.closed) return Promise.resolve();
    return (this.closing ??= this.stopLocal(this.child)
      .then(() => {
        this.closed = true;
      })
      .finally(() => {
        this.closing = undefined;
      }));
  }

  private async stopLocal(child: ChildProcess): Promise<void> {
    if (!this.url) child.kill("SIGTERM");
    // The CLI waits for cleanup and scopes every mutation to this exact network id.
    const down = spawn("deno", ["task", "down", "--profile", this.profile, "--bake", this.bake], {
      cwd: this.root,
      env: { ...process.env, PANDA_ID: this.id } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    down.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        down.kill("SIGTERM");
        reject(new Error(`Panda cleanup timed out: ${this.id}`));
      }, 120_000);
      down.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      down.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Panda cleanup failed: ${stderr}`));
      });
    });
    await this.exited;
  }
}
