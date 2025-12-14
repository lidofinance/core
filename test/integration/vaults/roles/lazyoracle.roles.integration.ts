import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LazyOracle } from "typechain-types";

import { days, ether, impersonate } from "lib";
import { getProtocolContext, ProtocolContext, setupLidoForVaults, testMethod } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: LazyOracle Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agent: HardhatEthersSigner;
  let sanityParamsUpdater: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let lazyOracle: LazyOracle;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    lazyOracle = ctx.contracts.lazyOracle;

    // Get DAO agent - it has DEFAULT_ADMIN_ROLE on LazyOracle
    agent = await ctx.getSigner("agent");

    [sanityParamsUpdater, stranger] = await ethers.getSigners();

    // Grant UPDATE_SANITY_PARAMS_ROLE from agent
    await lazyOracle.connect(agent).grantRole(await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(), sanityParamsUpdater);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Role-protected methods", () => {
    it("updateSanityParams - requires UPDATE_SANITY_PARAMS_ROLE", async () => {
      // This role is granted to agent on Hoodi testnet
      if (await lazyOracle.hasRole(await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(), agent.address)) {
        await lazyOracle.connect(agent).revokeRole(await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(), agent.address);
      }
      await testMethod(
        lazyOracle,
        "updateSanityParams",
        {
          successUsers: [sanityParamsUpdater],
          failingUsers: [stranger, agent],
        },
        [days(1n), 100n, ether("0.01")],
        await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(),
      );
    });
  });

  describe("Special sender-protected methods", () => {
    it("updateReportData - requires AccountingOracle as sender", async () => {
      const method = "updateReportData";
      const args: [bigint, bigint, string, string] = [
        BigInt(Math.floor(Date.now() / 1000)),
        1000n,
        "0x" + "0".repeat(64),
        "QmTest",
      ];

      // Should fail for unauthorized callers
      for (const user of [stranger, agent, sanityParamsUpdater]) {
        await expect(lazyOracle.connect(user)[method](...args)).to.be.revertedWithCustomError(
          lazyOracle,
          "NotAuthorized",
        );
      }

      // Should succeed for AccountingOracle
      const accountingOracleSigner = await impersonate(await ctx.contracts.accountingOracle.getAddress(), ether("10"));
      await expect(lazyOracle.connect(accountingOracleSigner)[method](...args)).to.not.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );
    });

    it("removeVaultQuarantine - requires VaultHub as sender", async () => {
      const method = "removeVaultQuarantine";
      const args: [string] = [ZeroAddress];

      // Should fail for unauthorized callers
      for (const user of [stranger, agent, sanityParamsUpdater]) {
        await expect(lazyOracle.connect(user)[method](...args)).to.be.revertedWithCustomError(
          lazyOracle,
          "NotAuthorized",
        );
      }

      // Should succeed for VaultHub
      const vaultHubSigner = await impersonate(await ctx.contracts.vaultHub.getAddress(), ether("10"));
      await expect(lazyOracle.connect(vaultHubSigner)[method](...args)).to.not.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );
    });
  });

  describe("Permissionless methods", () => {
    it("updateVaultData - anyone can call with valid proof", async () => {
      // This method is permissionless and uses merkle proof for validation
      // We just verify that it doesn't revert with NotAuthorized for stranger
      // (it will fail with InvalidProof, but that's expected)
      const method = "updateVaultData";
      const args: [string, bigint, bigint, bigint, bigint, bigint, string[]] = [ZeroAddress, 0n, 0n, 0n, 0n, 0n, []];

      // Should not revert with NotAuthorized (will revert with InvalidProof instead)
      await expect(lazyOracle.connect(stranger)[method](...args)).to.not.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );
    });
  });
});
