import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDGDeploymentDirectory, pickDGDeploymentArtifact } from "../../scripts/scratch/dg-artifacts";
import { ensureAuthorityTransfer, ensureFinalized, ensureRoleTransfer } from "../../scripts/scratch/recovery";
import { componentCheckInputs } from "../../scripts/scratch/state-mate/check-components";
import { collectSupplementalComponents } from "../../scripts/scratch/state-mate/components";

const deployer = "0xDeployer";
const agent = "0xAgent";
const template = "0xTemplate";
const voting = "0xVoting";

describe("Scratch deployment recovery", () => {
  for (const dg of [false, true]) {
    it(`recovers 0150 after every role/proxy/ownership transaction (DG=${dg})`, async () => {
      // Include an ordinary admin, a deferred sealable, a proxy and an ownable.
      const transactionCount = dg ? 5 : 6;
      for (let interruptAt = 1; interruptAt <= transactionCount; interruptAt++) {
        const admins = [new Set([deployer]), new Set([deployer])];
        const owners = [deployer, deployer];
        let transactions = 0;
        let interrupted = false;
        const send = async (effect: () => void) => {
          effect();
          if (++transactions === interruptAt && !interrupted) {
            interrupted = true;
            throw new Error("receipt connection lost after mining");
          }
        };
        const run = async () => {
          for (const [i, roles] of admins.entries()) {
            await ensureRoleTransfer(
              "admin",
              async (a) => roles.has(a),
              deployer,
              agent,
              () =>
                send(() => {
                  assert(roles.has(deployer));
                  roles.add(agent);
                }),
              () =>
                send(() => {
                  assert(roles.has(deployer));
                  roles.delete(deployer);
                }),
              dg && i === 1,
            );
          }
          for (let i = 0; i < owners.length; i++) {
            await ensureAuthorityTransfer(
              "owner",
              async () => owners[i],
              deployer,
              agent,
              () =>
                send(() => {
                  assert.equal(owners[i], deployer);
                  owners[i] = agent;
                }),
            );
          }
        };
        await assert.rejects(run(), /connection lost/);
        await run();
        await run();
        assert.equal(transactions, transactionCount, "replay must not resend completed transactions");
        assert(admins.every((roles) => roles.has(agent)));
        assert.equal(admins[0].has(deployer), false);
        assert.equal(admins[1].has(deployer), dg);
        assert.deepEqual(owners, [agent, agent]);
      }
    });

    for (const interruptAt of [1, 2]) {
      it(`recovers 0160 after transaction ${interruptAt} (DG=${dg})`, async () => {
        const expected = dg ? [agent, agent, agent, agent] : [voting, voting, voting, agent];
        let managers = Array(4).fill(template);
        let owner = deployer;
        let deployStateExists = true;
        let transactions = 0;
        let interrupted = false;
        const send = async (effect: () => void) => {
          effect();
          if (++transactions === interruptAt && !interrupted) {
            interrupted = true;
            throw new Error("interrupted after mining");
          }
        };
        const run = async () => {
          await ensureFinalized(
            async () => managers,
            template,
            expected,
            () =>
              send(() => {
                assert(deployStateExists, "finalize cannot run against deleted deployState");
                assert.equal(owner, deployer);
                managers = expected;
                deployStateExists = false;
              }),
          );
          await ensureAuthorityTransfer(
            "template owner",
            async () => owner,
            deployer,
            agent,
            () =>
              send(() => {
                owner = agent;
              }),
          );
        };
        await assert.rejects(run(), /interrupted/);
        await run();
        await run();
        assert.equal(transactions, 2);
        assert.deepEqual(managers, expected);
        assert.equal(owner, agent);
      });
    }
  }

  it("rejects unexpected authority and mixed finalization managers without transactions", async () => {
    const forbidden = async () => {
      assert.fail("must not transact");
    };
    await assert.rejects(
      ensureAuthorityTransfer("proxy", async () => voting, deployer, agent, forbidden),
      /unexpected authority/,
    );
    await assert.rejects(
      ensureRoleTransfer("admin", async () => false, deployer, agent, forbidden, forbidden),
      /neither/,
    );
    await assert.rejects(
      ensureFinalized(async () => [agent, template], template, [agent, agent], forbidden),
      /Unexpected/,
    );
  });

  it("does not report success when a transaction failed to establish its postcondition", async () => {
    await assert.rejects(
      ensureAuthorityTransfer(
        "proxy",
        async () => deployer,
        deployer,
        agent,
        async () => {},
      ),
      /postcondition/,
    );
    await assert.rejects(
      ensureFinalized(
        async () => [template],
        template,
        [agent],
        async () => {},
      ),
      /postconditions/,
    );
  });

  it("retains artifacts from deployments sharing chain ID and timestamp", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dg-artifacts-test-"));
    try {
      const source = path.join(root, "submodule");
      fs.mkdirSync(path.join(source, "deploy-artifacts"), { recursive: true });
      fs.copyFileSync("foundry/lib/dual-governance/foundry.toml", path.join(source, "foundry.toml"));
      fs.copyFileSync("foundry/lib/dual-governance/remappings.txt", path.join(source, "remappings.txt"));
      const old = path.join(source, "deploy-artifacts", "deploy-artifact-31337-100.toml");
      fs.writeFileSync(old, "legacy");
      const first = createDGDeploymentDirectory(source, path.join(root, "archive"), 31337);
      const second = createDGDeploymentDirectory(source, path.join(root, "archive"), 31337);
      assert.deepEqual(fs.readdirSync(source).sort(), ["deploy-artifacts", "foundry.toml", "remappings.txt"]);
      assert.equal(
        fs.readFileSync(path.join(first, "foundry.toml"), "utf8"),
        fs.readFileSync(path.join(second, "foundry.toml"), "utf8"),
      );
      assert.equal(fs.existsSync(path.join(first, "test")), false, "must not copy test sources");
      const output = path.join(first, "deploy-artifacts");
      assert.throws(() => pickDGDeploymentArtifact(31337, output), /found 0/);
      const artifact = "deploy-artifacts/deploy-artifact-31337-100.toml";
      fs.writeFileSync(path.join(first, artifact), "first");
      fs.writeFileSync(path.join(second, artifact), "second");
      assert.equal(pickDGDeploymentArtifact(31337, output), path.join(first, artifact));
      fs.writeFileSync(path.join(output, "deploy-artifact-1-100.toml"), "other chain");
      assert.equal(pickDGDeploymentArtifact(31337, output), path.join(first, artifact));
      fs.writeFileSync(path.join(output, "deploy-artifact-31337-101.toml"), "ambiguous");
      assert.throws(() => pickDGDeploymentArtifact(31337, output), /found 2/);
      assert.equal(fs.readFileSync(old, "utf8"), "legacy");
      assert.equal(fs.readFileSync(path.join(first, artifact), "utf8"), "first");
      assert.equal(fs.readFileSync(path.join(second, artifact), "utf8"), "second");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit component RPC and resolves state paths independently of cwd", () => {
    for (const value of [undefined, "", "   "]) {
      assert.throws(() => componentCheckInputs({ LOCAL_RPC_URL: value }), /LOCAL_RPC_URL must be set/);
    }
    const cwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      const inputs = componentCheckInputs({
        LOCAL_RPC_URL: "http://127.0.0.1:18561",
        NETWORK_STATE_FILE: "deployed-local.json",
      });
      assert.equal(inputs.stateFile, path.resolve(__dirname, "../../deployed-local.json"));
      assert.equal(inputs.rpcUrl, "http://127.0.0.1:18561");
      const absolute = path.join(os.tmpdir(), "other-state.json");
      assert.equal(
        componentCheckInputs({ LOCAL_RPC_URL: inputs.rpcUrl, NETWORK_STATE_FILE: absolute }).stateFile,
        absolute,
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it("scratch entry point reaches the external runner with the selected DG/genesis parameters", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-entry-test-"));
    try {
      const capture = path.join(root, "capture.json");
      fs.writeFileSync(
        path.join(root, "yarn"),
        `#!/usr/bin/env node
require("fs").writeFileSync(process.env.CAPTURE, JSON.stringify({
  args: process.argv.slice(2), mode: process.env.MODE, runtime: process.env.RUN_NETWORK,
  genesis: process.env.GENESIS_TIME, forkVersion: process.env.GENESIS_FORK_VERSION,
  dg: process.env.DG_DEPLOYMENT_ENABLED
}));
`,
        { mode: 0o755 },
      );
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const command = pkg.scripts["test:integration:scratch:local"].replace(
        "yarn test:integration",
        "bash scripts/run-test-integration.sh",
      );
      for (const dg of ["true", "false"]) {
        execFileSync("bash", ["-c", command + " test/integration/dual-governance/dg-scratch.integration.ts"], {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => [key, String(value)]),
            ),
            PATH: `${root}:${process.env.PATH}`,
            CAPTURE: capture,
            NETWORK_STATE_FILE: path.join(root, "state.json"),
            RPC_URL: "http://127.0.0.1:1",
            DG_DEPLOYMENT_ENABLED: dg,
            GENESIS_TIME: "1655733600",
            GENESIS_FORK_VERSION: "0x90000069",
          } as unknown as NodeJS.ProcessEnv,
        });
        const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
        assert.equal(captured.mode, "scratch");
        assert.equal(captured.runtime, "local");
        assert.equal(captured.genesis, "1655733600");
        assert.equal(captured.forkVersion, "0x90000069");
        assert.equal(captured.dg, dg);
        assert.deepEqual(captured.args.slice(0, 4), ["hardhat", "--network", "local", "test"]);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers nested optional modules, lists and artifact-only contracts without treating parameters as contracts", () => {
    const address = `0x${"1".repeat(40)}`;
    const entries = collectSupplementalComponents({
      "sm:CSM": {
        proxy: { address },
        contracts: { module: { proxy: { address }, implementation: { address } }, gates: { addresses: [address] } },
        deployArtifact: {
          HashConsensus: address,
          ExternalLibraries: { Library: address },
          DeployParams: { admin: address },
        },
      },
    });
    assert.equal(entries.length, 6);
    assert(entries.some((e) => e.label.includes("HashConsensus")));
    assert(!entries.some((e) => e.label.includes("DeployParams")));
    assert.deepEqual(collectSupplementalComponents({ circuitBreaker: { deployParameters: {} } }), []);
  });
});
