import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import hre from "hardhat";

import { getNetworkConfig, parseDeploymentJson } from "lib/protocol/networks";
import { Sk } from "lib/state-file";

function deployment(address: string) {
  const contract = { address, proxy: { address } };
  return {
    [Sk.chainSpec]: { chainId: String(hre.network.config.chainId) },
    ...Object.fromEntries(
      [
        Sk.lidoLocator,
        Sk.appAgent,
        Sk.appVoting,
        Sk.stakingVaultFactory,
        Sk.stakingVaultBeacon,
        Sk.operatorGrid,
        Sk.validatorConsolidationRequests,
        Sk.consolidationBus,
        Sk.consolidationMigrator,
      ].map((key) => [key, contract]),
    ),
  };
}

describe("Protocol deployment state selection", () => {
  let directory: string;
  let network: string;
  let defaultFile: string;
  let selectedFile: string;
  let originalStateFile: string | undefined;
  let originalMode: string | undefined;

  beforeEach(() => {
    originalStateFile = process.env.NETWORK_STATE_FILE;
    originalMode = process.env.MODE;
    delete process.env.NETWORK_STATE_FILE;
    directory = mkdtempSync(join(tmpdir(), "protocol-networks-"));
    network = basename(directory);
    defaultFile = resolve(`deployed-${network}.json`);
    selectedFile = join(directory, "selected deployment.json");
    writeFileSync(defaultFile, JSON.stringify(deployment("default")));
    writeFileSync(selectedFile, JSON.stringify(deployment("selected")));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({ NETWORK_STATE_FILE: originalStateFile, MODE: originalMode })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(defaultFile, { force: true });
    rmSync(directory, { recursive: true, force: true });
  });

  for (const override of [undefined, ""]) {
    it(`uses the named network default when the override is ${String(override)}`, async () => {
      if (override !== undefined) process.env.NETWORK_STATE_FILE = override;
      assert.deepEqual(await parseDeploymentJson(network), deployment("default"));
    });
  }

  for (const absolute of [false, true]) {
    it(`prefers an ${absolute ? "absolute" : "explicit relative"} state path over an existing default`, async () => {
      process.env.NETWORK_STATE_FILE = absolute ? selectedFile : relative(process.cwd(), selectedFile);
      assert.deepEqual(await parseDeploymentJson(network), deployment("selected"));
    });
  }

  it("rereads deployment state after the same file is replaced", async () => {
    process.env.NETWORK_STATE_FILE = selectedFile;
    assert.deepEqual(await parseDeploymentJson(network), deployment("selected"));
    writeFileSync(selectedFile, JSON.stringify(deployment("replacement")));
    assert.deepEqual(await parseDeploymentJson(network), deployment("replacement"));
  });

  for (const invalid of ["missing", "malformed"]) {
    it(`reports the selected ${invalid} file without falling back to another deployment`, async () => {
      process.env.NETWORK_STATE_FILE = selectedFile;
      if (invalid === "missing") rmSync(selectedFile);
      else writeFileSync(selectedFile, "{invalid json");
      await assert.rejects(parseDeploymentJson(network), (error: Error) => error.message.includes(selectedFile));
    });
  }

  it("rejects a selected deployment for a different chain", async () => {
    process.env.NETWORK_STATE_FILE = selectedFile;
    const state = deployment("wrong-chain");
    state[Sk.chainSpec].chainId = String(Number(hre.network.config.chainId) + 1);
    writeFileSync(selectedFile, JSON.stringify(state));
    await assert.rejects(parseDeploymentJson(network), /chainId.*does not match/);
  });

  for (const name of ["local", "localhost", "hardhat"]) {
    it(`uses the selected deployment in ${name} protocol configuration`, async () => {
      process.env.MODE = "scratch";
      process.env.NETWORK_STATE_FILE = selectedFile;
      const config = await getNetworkConfig(name);
      assert.equal(config.defaults.locator, "selected");
      assert.equal(config.defaults.agentAddress, "selected");
      assert.equal(config.defaults.stakingVaultFactory, "selected");
    });
  }
});
