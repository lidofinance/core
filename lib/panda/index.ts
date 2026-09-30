import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export interface PandaStatus {
  id: string;
  profile: string;
  bake: string;
  bakeKey: string;
  slot: number;
  el: { number: string; hash: string; timestamp: string };
}

/** Thin Node client: the Panda process owns Docker, EL/CL and protocol time. */
export class Panda {
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private closed = false;
  private constructor(
    readonly root: string,
    readonly id: string,
    readonly directory: string,
    readonly profile: string,
    readonly bake: string,
    public url = "",
  ) {}

  static async start({
    root = process.env.PANDA_ROOT,
    profile = "gloas",
    bake = process.env.PANDA_BAKE ?? "panda",
    output = ".local/panda",
    port = 0,
  } = {}): Promise<Panda> {
    assert.ok(root, "Set PANDA_ROOT to the local Panda checkout with baked Docker images");
    const id = `core-${randomUUID().slice(0, 8)}`;
    const panda = new Panda(path.resolve(root), id, path.resolve(output, id), profile, bake);
    await mkdir(panda.directory, { recursive: true });
    const log = createWriteStream(path.join(panda.directory, "network.log"));
    const child = spawn(path.join(panda.root, "scripts/deno"), ["task", "up", "--profile", profile, "--bake", bake], {
      cwd: panda.root,
      env: { ...process.env, PANDA_ID: id, PANDA_PORT: String(port) } as unknown as NodeJS.ProcessEnv,
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
        const timer = setTimeout(() => reject(new Error(`Panda startup timed out: ${panda.directory}`)), 120_000);
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
      assert.equal(status.id, id);
      assert.equal(status.profile, profile);
      assert.equal(status.bake, bake);
      assert.equal(BigInt(status.el.number), 0n, "Panda must start a fresh chain");
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
      signal: AbortSignal.timeout(120_000),
    });
    assert.ok(response.ok, `Panda HTTP ${response.status}`);
    const body = (await response.json()) as { result: T; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  async beacon<T>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(this.url + route, {
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `Beacon ${route}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  status(): Promise<PandaStatus> {
    return this.rpc("status", [], true);
  }
  advanceSlots(count: number): Promise<void> {
    return this.rpc("advanceSlots", [count], true);
  }
  advanceTo(timestamp: number): Promise<void> {
    return this.rpc("advanceTo", [timestamp], true);
  }
  setAutomine(enabled: boolean): Promise<void> {
    return this.rpc("setAutomine", [enabled], true);
  }

  /** Import an EIP-2335 key so newly deposited validators can perform their duties. */
  async importValidator(keystore: string, password: string): Promise<void> {
    const result = await this.keymanager<{ data: { status: string; message?: string }[] }>("/eth/v1/keystores", {
      keystores: [keystore],
      passwords: [password],
    });
    assert.equal(result.data[0]?.status, "imported", result.data[0]?.message);
  }

  async exitValidator(pubkey: string): Promise<void> {
    assert.match(pubkey, /^0x[0-9a-f]{96}$/i);
    const signed = await this.keymanager<{ data: unknown }>(`/eth/v1/validator/${pubkey}/voluntary_exit`);
    await this.beacon("/eth/v1/beacon/pool/voluntary_exits", signed.data);
  }

  private async keymanager<T>(route: string, body?: unknown): Promise<T> {
    const manifest = JSON.parse(await readFile(path.join(this.root, ".panda", this.id, "manifest.json"), "utf8"));
    assert.equal(manifest.config.id, this.id);
    assert.equal(new URL(manifest.vc).hostname, "127.0.0.1");
    const token = (await readFile(path.join(manifest.directory, "validator-keys/keys/api-token.txt"), "utf8")).trim();
    const response = await fetch(`${manifest.vc}${route}`, {
      method: "POST",
      headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `Validator keymanager: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  async close(): Promise<void> {
    if (!this.child || this.closed) return;
    this.closed = true;
    if (!this.url) this.child.kill("SIGTERM");
    // The CLI waits for cleanup and scopes every mutation to this exact network id.
    const down = spawn(
      path.join(this.root, "scripts/deno"),
      ["task", "down", "--profile", this.profile, "--bake", this.bake],
      {
        cwd: this.root,
        env: { ...process.env, PANDA_ID: this.id } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
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
