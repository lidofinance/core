import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "chai";
import { HDNodeWallet, Interface, Provider, Wallet } from "ethers";
import {
  assertSiLidityBindings,
  checkSiLidityDeployment,
  parseSiLidityAddresses,
  requireSiLidityAddresses,
  resolveSiLidityRpcUrl,
} from "scripts/scratch/si-lidity/checks";
import {
  assertSiLidityVerificationSupported,
  requireSiLidityArchive,
  siLiditySignerAccounts,
  siLidityToolingEnv,
} from "scripts/scratch/si-lidity/tooling";

const first = "0x0000000000000000000000000000000000000001";
const second = "0x0000000000000000000000000000000000000002";

describe("si-lidity deployment boundaries", () => {
  it("requires the selected network's RPC instead of falling back to an environment URL", () => {
    expect(() => resolveSiLidityRpcUrl({})).to.throw("external HTTP RPC");
    expect(resolveSiLidityRpcUrl({ url: "http://127.0.0.1:18555" })).to.equal("http://127.0.0.1:18555");
  });

  it("rejects incomplete or invalid Ignition output", () => {
    expect(() => parseSiLidityAddresses({ "ScratchHelpers#VaultViewer": first })).to.throw("WstETHReferralStaker");
    expect(() =>
      parseSiLidityAddresses({
        "ScratchHelpers#VaultViewer": "not-an-address",
        "ScratchHelpers#WstETHReferralStaker": second,
      }),
    ).to.throw();
    expect(
      parseSiLidityAddresses({
        "ScratchHelpers#VaultViewer": first,
        "ScratchHelpers#WstETHReferralStaker": second,
      }),
    ).to.deep.equal({ vaultViewer: first, wstETHReferralStaker: second });
  });

  it("prevents a retained journal from deploying against changed constructor dependencies", () => {
    const bindings = { lidoLocator: first, vaultHub: first, lazyOracle: first, stETH: first, wstETH: first };
    expect(() => assertSiLidityBindings(bindings, bindings)).not.to.throw();
    for (const key of Object.keys(bindings)) {
      expect(() => assertSiLidityBindings(bindings, { ...bindings, [key]: second })).to.throw(`different ${key}`);
    }
  });
});

describe("si-lidity review regressions", () => {
  const bindings = { lidoLocator: first, vaultHub: first, lazyOracle: first, stETH: first, wstETH: first };

  it("identifies incomplete addresses and metadata before making RPC calls", async () => {
    for (const key of ["vaultViewer", "wstETHReferralStaker"] as const) {
      expect(() => requireSiLidityAddresses({ [key]: first })).to.throw("deployment incomplete");
    }
    await assert.rejects(
      checkSiLidityDeployment({} as Provider, { vaultViewer: first } as never, bindings),
      /wstETHReferralStaker/,
    );
    expect(() => assertSiLidityBindings(undefined, bindings)).to.throw("valid lidoLocator binding");
    expect(() => assertSiLidityBindings({ ...bindings, lazyOracle: undefined }, bindings)).to.throw(
      "valid lazyOracle binding",
    );
  });

  it("names the actual and expected constructor binding on mismatch", async () => {
    const abi = new Interface([
      "function LIDO_LOCATOR() view returns (address)",
      "function VAULT_HUB() view returns (address)",
      "function LAZY_ORACLE() view returns (address)",
      "function stETH() view returns (address)",
      "function wstETH() view returns (address)",
      "function vaultsCount() view returns (uint256)",
    ]);
    const provider = {
      getCode: async () => "0x01",
      call: async ({ data }: { data: string }) => {
        const fn = abi.getFunction(data.slice(0, 10))!;
        return abi.encodeFunctionResult(fn, [
          fn.name === "vaultsCount" ? 0n : fn.name === "LAZY_ORACLE" ? second : first,
        ]);
      },
    } as unknown as Provider;
    await assert.rejects(
      checkSiLidityDeployment(provider, { vaultViewer: first, wstETHReferralStaker: second }, bindings),
      new RegExp(`LAZY_ORACLE mismatch: expected ${first}, got ${second}`),
    );
  });

  it("excludes unrelated environment secrets and runtime injection", () => {
    expect(
      siLidityToolingEnv({
        PATH: "/bin",
        HOME: "/home/test",
        ETHERSCAN_API_KEY: "secret",
        PRIVATE_KEY: "secret",
        RPC_URL: "secret",
        NODE_OPTIONS: "--require inject.js",
      }),
    ).to.deep.equal({ PATH: "/bin", HOME: "/home/test", CI: "true" });
  });

  it("passes only the selected signer for raw keys, HD accounts, or remote signing", () => {
    const one = new Wallet("0x" + "01".repeat(32));
    const two = new Wallet("0x" + "02".repeat(32));
    expect(siLiditySignerAccounts([one.privateKey, two.privateKey], two.address)).to.deep.equal([two.privateKey]);
    expect(() => siLiditySignerAccounts([one.privateKey], two.address)).to.throw("absent");
    expect(siLiditySignerAccounts("remote", first)).to.equal("remote");
    const config = {
      mnemonic: "test test test test test test test test test test test junk",
      path: "m/44'/60'/0'/0",
      passphrase: "test",
      initialIndex: 2,
      count: 3,
    };
    const selected = HDNodeWallet.fromPhrase(config.mnemonic, config.passphrase, config.path).deriveChild(3);
    expect(siLiditySignerAccounts(config, selected.address)).to.deep.equal([selected.privateKey]);
  });

  it("refuses a lost checkout or journal instead of redeploying", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "si-lidity-archive-"));
    try {
      expect(() => requireSiLidityArchive(path.join(directory, "missing"))).to.throw("restore the archived directory");
      expect(() => requireSiLidityArchive(directory)).not.to.throw();
      expect(() => requireSiLidityArchive(directory, "revision")).to.throw("checkout/journal is missing");
      fs.mkdirSync(path.join(directory, "repo/.git"), { recursive: true });
      expect(() => requireSiLidityArchive(directory, "revision", true)).to.throw(
        "journal is missing after deployment started",
      );
      fs.mkdirSync(path.join(directory, "repo/ignition/deployments/scratch"), { recursive: true });
      fs.writeFileSync(path.join(directory, "repo/ignition/deployments/scratch/journal.jsonl"), "{}");
      expect(() => requireSiLidityArchive(directory, "revision", true)).not.to.throw();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not silently claim unsupported explorer verification", () => {
    for (const value of [undefined, "", "false", "0"])
      expect(() => assertSiLidityVerificationSupported({ VERIFY_ON_EXPLORER: value })).not.to.throw();
    for (const value of ["true", "1"])
      expect(() => assertSiLidityVerificationSupported({ VERIFY_ON_EXPLORER: value })).to.throw(
        "does not support Ignition explorer verification",
      );
  });
});
