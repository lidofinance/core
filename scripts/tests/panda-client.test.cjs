const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
require("ts-node/register/transpile-only");
const { Panda } = require("../../lib/panda/index.ts");

const root = `0x${"ab".repeat(32)}`;
const executionHash = `0x${"cd".repeat(32)}`;
const parentHash = `0x${"ef".repeat(32)}`;
const genesisTime = 2000000000;

// HTTP fixtures verify SDK checks and routing, not real client/protocol compatibility.
async function fixture(run) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "panda-client-"));
  const calls = [];
  const beaconCalls = [];
  const status = {
    id: "service-unit",
    profile: "gloas",
    bake: "r1",
    bakeKey: "a".repeat(64),
    slot: 0,
    automine: false,
    el: { number: "0x0", hash: executionHash, timestamp: `0x${genesisTime.toString(16)}` },
  };
  const header = {
    execution_optimistic: false,
    data: { canonical: true, root, header: { message: { slot: "0", state_root: root } } },
  };
  const genesis = { data: { genesis_time: String(genesisTime), genesis_validators_root: root } };
  const spec = {
    data: { PRESET_BASE: "mainnet", SECONDS_PER_SLOT: "12", DEPOSIT_CHAIN_ID: "1337", GLOAS_FORK_EPOCH: "0" },
  };
  const block = {
    version: "gloas",
    execution_optimistic: false,
    data: {
      message: {
        slot: "64",
        body: {
          signed_execution_payload_bid: { message: { block_hash: executionHash, parent_block_hash: parentHash } },
        },
      },
    },
  };
  const envelope = {
    version: "gloas",
    execution_optimistic: false,
    data: {
      message: {
        beacon_block_root: root,
        payload: {
          slot_number: "64",
          block_hash: executionHash,
          parent_hash: parentHash,
          block_number: "12",
          timestamp: String(genesisTime + 64 * 12),
        },
      },
    },
  };
  const el = { number: "0xc", hash: executionHash, parentHash, timestamp: `0x${(genesisTime + 64 * 12).toString(16)}` };
  const finality = { execution_optimistic: false, data: { finalized: { epoch: "2", root } } };
  const finalized = { number: "0xb", hash: parentHash, timestamp: "0x1" };
  const routes = {
    "/eth/v1/beacon/headers/head": header,
    "/eth/v1/beacon/genesis": genesis,
    "/eth/v1/config/spec": spec,
    [`/eth/v2/beacon/blocks/${root}`]: block,
    [`/eth/v1/beacon/execution_payload_envelopes/${root}`]: envelope,
    "/eth/v1/beacon/states/head/finality_checkpoints": finality,
    "/eth/v1/beacon/pool/voluntary_exits": { data: "accepted" },
  };
  const proxyRoutes = structuredClone(routes);
  const controller = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/eth/")) {
      // Keep a healthy proxy independent from native CL failures/mismatches.
      res.end(JSON.stringify(proxyRoutes[req.url]));
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    calls.push(request);
    const result =
      request.method === "status"
        ? status
        : request.method === "eth_chainId"
          ? "0x539"
          : request.method === "eth_getBlockByNumber"
            ? request.params[0] === "finalized"
              ? finalized
              : el
            : null;
    res.end(JSON.stringify({ result }));
  });
  const cl = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    beaconCalls.push({ route: req.url, method: req.method, body: text ? JSON.parse(text) : undefined });
    const data = routes[req.url];
    res.setHeader("content-type", "application/json");
    res.statusCode = data ? 200 : 503;
    res.end(JSON.stringify(data ?? { error: "CL unavailable" }));
  });
  await new Promise((resolve) => controller.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => cl.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${controller.address().port}`;
  const beaconUrl = `http://127.0.0.1:${cl.address().port}`;
  const start = (options = {}) =>
    Panda.start({ url, beaconUrl, root: "/nonexistent-panda", output, bake: "r1", ...options });
  try {
    await run({
      start,
      url,
      beaconUrl,
      calls,
      beaconCalls,
      status,
      header,
      genesis,
      spec,
      block,
      envelope,
      el,
      finality,
      finalized,
      routes,
    });
  } finally {
    await Promise.all([controller, cl].map((server) => new Promise((resolve) => server.close(resolve))));
    await fs.rm(output, { recursive: true, force: true });
  }
}

test("external Panda needs no checkout, preserves fresh genesis and does not own shutdown", async () => {
  await fixture(async ({ start, url, beaconUrl, calls, status }) => {
    const panda = await start();
    assert.equal(panda.url, url);
    assert.equal(panda.beaconUrl, beaconUrl);
    assert.equal(panda.id, "service-unit");
    await panda.importValidator("{}", "password");
    await panda.exitValidator(`0x${"ab".repeat(48)}`);
    assert.deepEqual(
      calls.filter((c) => ["importValidator", "exitValidator"].includes(c.method)).map((c) => [c.method, c.params]),
      [
        ["importValidator", ["{}", "password"]],
        ["exitValidator", [`0x${"ab".repeat(48)}`]],
      ],
    );
    await panda.advanceTo(2000000000);
    await panda.advanceTo(2000098304, { mode: "fast" });
    assert.deepEqual(
      calls.filter((c) => c.method === "advanceTo").map((c) => c.params),
      [[2000000000], [2000098304, { mode: "fast" }]],
    );
    await panda.close();
    status.el.number = "0x1";
    await assert.rejects(start(), /fresh chain/);
    assert.equal(
      calls.some((c) => ["shutdown", "down"].includes(c.method)),
      false,
    );
  });
});

test("SDK routes Beacon reads and writes to native CL and keeps the controller proxy as default", async () => {
  await fixture(async ({ start, beaconCalls, url }) => {
    const panda = await start();
    await panda.beacon("/eth/v1/beacon/genesis");
    const body = { message: { epoch: "4" }, signature: "fixture" };
    assert.deepEqual(await panda.beacon("/eth/v1/beacon/pool/voluntary_exits", body), { data: "accepted" });
    assert.deepEqual(beaconCalls.at(-1), { route: "/eth/v1/beacon/pool/voluntary_exits", method: "POST", body });
    assert.equal((await start({ beaconUrl: "" })).beaconUrl, url);
  });
});

test("SDK rejects stale, optimistic, noncanonical or mismatched CL genesis", async () => {
  const cases = [
    [
      (f) => {
        f.header.data.header.message.slot = "1";
      },
      /CL must start at genesis/,
    ],
    [
      (f) => {
        f.header.execution_optimistic = true;
      },
      /optimistic/,
    ],
    [
      (f) => {
        f.header.data.canonical = false;
      },
      /canonical/,
    ],
    [
      (f) => {
        f.header.data.root = parentHash;
      },
      /same Beacon head/,
    ],
    [
      (f) => {
        f.genesis.data.genesis_time = "1";
      },
      /genesis time/,
    ],
    [
      (f) => {
        f.spec.data.DEPOSIT_CHAIN_ID = "1";
      },
      /chain ID/,
    ],
    [
      (f) => {
        f.spec.data.GLOAS_FORK_EPOCH = "1";
      },
      /Gloas/,
    ],
    [
      (f) => {
        delete f.routes["/eth/v1/beacon/genesis"];
      },
      /HTTP 503/,
    ],
  ];
  for (const [change, message] of cases) {
    await fixture(async (f) => {
      change(f);
      await assert.rejects(f.start(), message);
    });
  }
});

test("SDK validates CL URL and does not fall back when an explicit CL is unavailable", async () => {
  await fixture(async ({ start, beaconCalls, routes }) => {
    for (const beaconUrl of [
      "file:///tmp/beacon",
      "http://localhost/path",
      "http://user:secret@localhost",
      "http://localhost/?a=1",
    ]) {
      await assert.rejects(start({ beaconUrl }), /PANDA_BEACON_URL/);
    }
    delete routes["/eth/v1/beacon/genesis"];
    await assert.rejects(start(), /HTTP 503/);
    assert.ok(beaconCalls.some((c) => c.route === "/eth/v1/beacon/genesis"));
  });
});

test("SDK verifies the Gloas bid, envelope and canonical EL block for an immutable Beacon root", async () => {
  await fixture(async ({ start, calls, beaconCalls }) => {
    const panda = await start();
    const result = await panda.assertExecution(root);
    assert.equal(result.executionHash, executionHash);
    assert.equal(result.executionNumber, "0xc");
    assert.equal(result.slot, "64");
    assert.ok(calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] === "0xc"));
    assert.ok(beaconCalls.some((c) => c.route === `/eth/v1/beacon/execution_payload_envelopes/${root}`));
  });
});

test("SDK rejects an optimistic or conflicting Gloas bid, envelope and EL block", async () => {
  const cases = [
    [
      (f) => {
        f.block.execution_optimistic = true;
      },
      /optimistic/,
    ],
    [
      (f) => {
        f.block.version = "electra";
      },
      /Gloas/,
    ],
    [
      (f) => {
        f.envelope.execution_optimistic = true;
      },
      /optimistic/,
    ],
    [
      (f) => {
        f.envelope.data.message.beacon_block_root = parentHash;
      },
      /Beacon root/,
    ],
    [
      (f) => {
        f.envelope.data.message.payload.slot_number = "65";
      },
      /slot/,
    ],
    [
      (f) => {
        f.envelope.data.message.payload.block_hash = parentHash;
      },
      /bid/,
    ],
    [
      (f) => {
        f.envelope.data.message.payload.parent_hash = executionHash;
      },
      /parent/,
    ],
    [
      (f) => {
        f.envelope.data.message.payload.timestamp = "1";
      },
      /slot timestamp/,
    ],
    [
      (f) => {
        f.el.hash = parentHash;
      },
      /EL\/CL execution hash/,
    ],
    [
      (f) => {
        f.el.number = "0xd";
      },
      /block number/,
    ],
    [
      (f) => {
        f.el.timestamp = "0x1";
      },
      /execution timestamp/,
    ],
    [
      (f) => {
        delete f.routes[`/eth/v1/beacon/execution_payload_envelopes/${root}`];
      },
      /HTTP 503/,
    ],
  ];
  for (const [change, message] of cases) {
    await fixture(async (f) => {
      const panda = await f.start();
      change(f);
      await assert.rejects(panda.assertExecution(root), message);
    });
  }
});

test("SDK confirms Gloas finality using the checkpoint execution parent, not its own payload", async () => {
  await fixture(async ({ start, finality, finalized }) => {
    const panda = await start();
    assert.deepEqual(await panda.finalized(), {
      epoch: "2",
      root,
      executionHash: parentHash,
      executionNumber: "0xb",
    });
    finalized.hash = executionHash;
    await assert.rejects(panda.finalized(), /checkpoint execution parent/);
    finalized.hash = parentHash;
    finality.execution_optimistic = true;
    await assert.rejects(panda.finalized(), /optimistic/);
    finality.execution_optimistic = false;
    finality.data.finalized.epoch = "0";
    assert.equal(await panda.finalized(), null);
  });
});

test("SDK uses PANDA_BEACON_URL from CI and rejects invalid checkpoint evidence", async () => {
  await fixture(async ({ start, beaconUrl, block }) => {
    const previous = process.env.PANDA_BEACON_URL;
    process.env.PANDA_BEACON_URL = beaconUrl;
    try {
      const panda = await start({ beaconUrl: undefined });
      assert.equal(panda.beaconUrl, beaconUrl);
      block.execution_optimistic = true;
      await assert.rejects(panda.finalized(), /optimistic/);
      block.execution_optimistic = false;
      block.data.message.slot = "65";
      await assert.rejects(panda.finalized(), /epoch boundary/);
      block.data.message.slot = "64";
      block.version = "electra";
      await assert.rejects(panda.finalized(), /Gloas checkpoint/);
    } finally {
      if (previous === undefined) delete process.env.PANDA_BEACON_URL;
      else process.env.PANDA_BEACON_URL = previous;
    }
  });
});
