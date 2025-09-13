import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, days } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  report,
  setupLidoForVaults,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub ", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator] = await ethers.getSigners();
    await setupLidoForVaults(ctx);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Freshness", () => {
    it("Vault is created with fresh report", async () => {
      const { stakingVaultFactory, vaultHub } = ctx.contracts;

      const { stakingVault } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
      );

      expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;
    });

    it("Vault freshness is expiring after 2 days after report", async () => {
      const { stakingVaultFactory, vaultHub } = ctx.contracts;

      const { stakingVault } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
      );

      expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;

      await advanceChainTime(days(2n));

      expect(await vaultHub.isReportFresh(stakingVault)).to.be.false;
    });

    it("Vault freshness is expiring after the next report", async () => {
      const { stakingVaultFactory, vaultHub } = ctx.contracts;

      const { stakingVault } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
      );

      expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;

      await report(ctx, { clDiff: ether("0"), waitNextReportTime: true });

      expect(await vaultHub.isReportFresh(stakingVault)).to.be.false;
    });

    it("Vault is created with fresh report after refSlot but before report", async () => {
      const { stakingVaultFactory, vaultHub } = ctx.contracts;

      await waitNextAvailableReportTime(ctx);

      const { stakingVault } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
      );

      expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;

      await report(ctx, { clDiff: ether("0"), waitNextReportTime: false });

      expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;
    });
  });
});
