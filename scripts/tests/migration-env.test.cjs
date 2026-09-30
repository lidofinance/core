const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function prepare(extra) {
  const directory = mkdtempSync(path.join(tmpdir(), "lido-migration-env-"));
  const env = {
    PATH: process.env.PATH,
    MODE: "scratch",
    NETWORK: "local-devnet",
    RPC_URL: "http://127.0.0.1:18546",
    ...extra,
  };
  try {
    const script = path.resolve(__dirname, "../utils/migration-env.sh");
    const output = execFileSync(
      "bash",
      [
        "-c",
        '. "$1"; prepare_migration_env >/dev/null; printf "%s|%s|%s" "$GENESIS_TIME" "$GAS_LIMIT" "$STEPS_FILE"',
        "migration-env-test",
        script,
      ],
      { cwd: directory, env, encoding: "utf8" },
    );
    return output.split("|");
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("scratch preserves the actual network genesis and supports RPC gas estimation", () => {
  assert.deepEqual(prepare({ GENESIS_TIME: "2000000000" }), ["2000000000", "", "scratch/steps.json"]);
});

test("an explicitly configured fixed gas limit is preserved", () => {
  assert.equal(prepare({ GAS_LIMIT: "7000000" })[1], "7000000");
});
