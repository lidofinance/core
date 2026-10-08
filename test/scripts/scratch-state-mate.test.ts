import { strict as assert } from "node:assert";
import fs from "node:fs";

import { isScalar, isSeq, parseDocument } from "yaml";

import { parse as parseToml } from "@iarna/toml";

import { checkAbiCoverage, checkScratchAbis } from "../../scripts/scratch/state-mate/check-abi";
import { buildInputsYaml } from "../../scripts/scratch/state-mate/prepare-state-mate-check";

const config = `l1:
  contracts:
    example:
      name: Example
      address: *generatedAddress
      checks:
        version: 4
        balanceOf: null
`;
const abi = ["function version() view returns (uint256)", "function balanceOf(address) view returns (uint256)"];

function inputs(state: Record<string, unknown>) {
  const doc = parseDocument(buildInputsYaml(state));
  assert.deepEqual(doc.errors, []);
  const values = doc.get("config");
  assert(isSeq(values));
  return Object.fromEntries(
    values.items.map((node) => {
      assert(isScalar(node) || isSeq(node));
      return [node.anchor, node.toJSON()];
    }),
  );
}

function fixture() {
  const params = parseToml(fs.readFileSync("scripts/scratch/deploy-params-testnet.toml", "utf8"));
  const state: Record<string, unknown> = Object.fromEntries(
    Object.entries(params).map(([key, deployParameters]) => [key, { deployParameters }]),
  );
  return Object.assign(state, {
    "app:lido": state.lido,
    "validatorsExitBusOracle": {
      ...(state.validatorsExitBusOracle as object),
      proxy: { address: `0x${"7".repeat(40)}` },
    },
    "chainSpec": { slotsPerEpoch: 32, secondsPerSlot: 12, genesisTime: 1639659600, genesisForkVersion: "0x10000000" },
    "chainId": 31337,
    "deployer": `0x${"1".repeat(40)}`,
    "withdrawalVault": { proxy: { address: `0x${"2".repeat(40)}` } },
    "daoInitialSettings": (params.dao as { initialSettings: unknown }).initialSettings,
    "lidoApmEnsName": "lidopm.eth",
  });
}

describe("Scratch state-mate specification", () => {
  it("covers the compiled core ABI before deployment", () => {
    assert(checkScratchAbis() > 0);
  });

  it("checks coverage without requiring generated deployment aliases", () => {
    assert.equal(
      checkAbiCoverage(config, () => abi),
      1,
    );
  });

  it("rejects newly added getters and removed getters, including explicit skips", () => {
    assert.throws(
      () => checkAbiCoverage(config, () => [...abi, "function newGetter() view returns (uint256)"]),
      /uncovered newGetter/,
    );
    assert.throws(() => checkAbiCoverage(config, () => [abi[0]]), /removed\/unknown function balanceOf/);
    assert.throws(() => checkAbiCoverage(config, () => [abi[1]]), /removed\/unknown function version/);
  });

  it("checks proxy coverage and implementation method existence", () => {
    const proxy =
      config +
      `      proxyName: Proxy
      proxyChecks:
        admin: *generatedAdmin
      implementationChecks:
        oldVersion: null
`;
    assert.throws(
      () => checkAbiCoverage(proxy, (name) => (name === "Proxy" ? ["function admin() view returns (address)"] : abi)),
      /implementationChecks: removed\/unknown function oldVersion/,
    );
    assert.throws(
      () =>
        checkAbiCoverage(proxy, (name) =>
          name === "Proxy"
            ? ["function admin() view returns (address)", "function implementation() view returns (address)"]
            : abi,
        ),
      /proxyChecks: uncovered implementation/,
    );
  });

  it("fails closed for empty sections and malformed YAML", () => {
    assert.throws(() => checkAbiCoverage("l1: {contracts: {}}", () => abi), /No contracts/);
    assert.throws(() => checkAbiCoverage(config + "l1: {}\n", () => abi), /unique/);
  });

  for (const csm of [false, true])
    for (const cm of [false, true]) {
      it(`derives module IDs from the selected topology (CSM=${csm}, CM=${cm})`, () => {
        const state = fixture();
        if (csm)
          state["sm:CSM"] = {
            proxy: { address: `0x${"3".repeat(40)}` },
            deployArtifact: { Accounting: `0x${"5".repeat(40)}`, Ejector: `0x${"8".repeat(40)}` },
          };
        if (cm)
          state["sm:CM"] = {
            proxy: { address: `0x${"4".repeat(40)}` },
            deployArtifact: { Accounting: `0x${"6".repeat(40)}`, Ejector: `0x${"9".repeat(40)}` },
          };
        const expected = 2 + Number(csm) + Number(cm);
        const result = inputs(state);
        assert.equal(result.stakingModulesCount, expected);
        assert.deepEqual(result.triggerableWithdrawalsGateway_requestRoleMembers, [
          `0x${"7".repeat(40)}`,
          ...(csm ? [`0x${"8".repeat(40)}`] : []),
          ...(cm ? [`0x${"9".repeat(40)}`] : []),
        ]);
        assert.deepEqual(result.burner_requestBurnMyStethRoleMembers, [
          ...(csm ? [`0x${"5".repeat(40)}`] : []),
          ...(cm ? [`0x${"6".repeat(40)}`] : []),
        ]);
        assert.deepEqual(
          result.stakingModuleIds,
          Array.from({ length: expected }, (_, i) => i + 1),
        );
      });
    }

  it("rejects missing protocol inputs and missing optional-module role holders", () => {
    const state = fixture();
    const limits = (state.oracleReportSanityChecker as { deployParameters: Record<string, unknown> }).deployParameters;
    delete limits.externalPendingBalanceCapEth;
    assert.throws(
      () => buildInputsYaml(state),
      /missing deploy parameter "oracleReportSanityChecker.externalPendingBalanceCapEth"/,
    );
    const optional = fixture();
    optional["sm:CSM"] = { proxy: { address: `0x${"3".repeat(40)}` } };
    assert.throws(() => buildInputsYaml(optional), /missing sm:CSM.deployArtifact.Accounting/);
  });

  it("preserves configured limits, tuple order and large integer precision", () => {
    const state = fixture();
    const limits = (state.oracleReportSanityChecker as { deployParameters: Record<string, unknown> }).deployParameters;
    limits.exitedEthAmountPerDayLimit = 123;
    limits.externalPendingBalanceCapEth = 456;
    const gateway = (state.triggerableWithdrawalsGateway as { deployParameters: Record<string, unknown> })
      .deployParameters;
    gateway.maxExitRequestsLimit = 17;
    gateway.exitsPerFrame = 2;
    gateway.frameDurationInSec = 91;
    const result = inputs(state);
    assert.deepEqual(
      result.oracleReportSanityChecker_limits,
      [123, 57600, 1000, 250, 19200, 32, 2048, 8, 24, 128, 5000000, 360, 50, 93375, 32, 456],
    );
    assert.deepEqual(result.triggerableWithdrawalsGateway_exitRequestLimit, [17, 2, 91, 17, 17]);
    assert.equal(result.lido_depositsReserveTarget, "1500000000000000000000");
    assert.equal(result.accountingOracle_consensusVersion, 6);
    assert.equal(result.validatorsExitBusOracle_consensusVersion, 5);
  });
});
