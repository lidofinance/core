import { expect } from "chai";
import { beforeEach } from "mocha";

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import type { Accounting } from "typechain-types/index.js";

import { ethers } from "lib/hardhat.js";
import { ether, impersonate } from "lib/index.js";
import { getProtocolContext, type ProtocolContext, setupLidoForVaults } from "lib/protocol/index.js";

import { Snapshot } from "test/suite/index.js";

describe("Integration: Accounting Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let stranger: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  let accounting: Accounting;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    agent = await ctx.getSigner("agent");

    accounting = ctx.contracts.accounting;

    [stranger] = await ethers.getSigners();
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Special sender-protected methods", () => {
    it("handleOracleReport - requires AccountingOracle as sender", async () => {
      const method = "handleOracleReport";
      // Minimal report structure (will fail for other reasons but not NotAuthorized for stranger)
      const report = {
        timestamp: 0n,
        timeElapsed: 0n,
        clValidatorsBalance: 0n,
        clPendingBalance: 0n,
        withdrawalVaultBalance: 0n,
        elRewardsVaultBalance: 0n,
        sharesRequestedToBurn: 0n,
        withdrawalFinalizationBatches: [],
        simulatedShareRate: 0n,
      };
      const args: [typeof report] = [report];

      // Should fail for unauthorized callers
      for (const user of [stranger, agent]) {
        await expect(accounting.connect(user)[method](...args)).to.be.revertedWithCustomError(
          accounting,
          "NotAuthorized",
        );
      }

      // Should succeed for AccountingOracle
      const accountingOracleSigner = await impersonate(await ctx.contracts.accountingOracle.getAddress(), ether("10"));
      await expect(accounting.connect(accountingOracleSigner)[method](...args)).to.not.be.revertedWithCustomError(
        accounting,
        "NotAuthorized",
      );
    });
  });
});
