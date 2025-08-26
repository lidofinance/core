import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, OperatorGrid, StakingVault, VaultHub } from "typechain-types";

import { ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  report,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: OperatorGrid", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let vaultHub: VaultHub;
  let operatorGrid: OperatorGrid;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    await report(ctx);

    ({ vaultHub, operatorGrid } = ctx.contracts);

    [owner, nodeOperator] = await ethers.getSigners();

    // Owner can create a vault with an operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);

    await dashboard.fund({ value: ether("10") });
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true, "Report is fresh after setup");
    expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true, "Vault is healthy after setup");
  });

  describe("Change tier logic", () => {
    let agentSigner: HardhatEthersSigner;

    beforeEach(async () => {
      agentSigner = await ctx.getSigner("agent");
    });

    it("change tier should work", async () => {
      // Register a group and two tiers for the node operator
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("2000"),
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
        {
          shareLimit: ether("3000"),
          reserveRatioBP: 2500,
          forcedRebalanceThresholdBP: 2000,
          infraFeeBP: 600,
          liquidityFeeBP: 450,
          reservationFeeBP: 150,
        },
      ]);

      // Initially vault is in default tier (0)
      const beforeInfo = await operatorGrid.vaultInfo(stakingVault);
      expect(beforeInfo.tierId).to.equal(0n);

      const requestedTierId = 1n;
      const requestedShareLimit = ether("1000");

      // First confirmation from vault owner via Dashboard → returns false (not yet confirmed)
      expect(await dashboard.changeTier.staticCall(requestedTierId, requestedShareLimit)).to.equal(false);
      await dashboard.changeTier(requestedTierId, requestedShareLimit);

      // Second confirmation from node operator → completes and updates connection
      await expect(
        operatorGrid.connect(nodeOperator).changeTier(stakingVault, requestedTierId, requestedShareLimit),
      ).to.emit(vaultHub, "VaultConnectionUpdated");

      const afterInfo = await operatorGrid.vaultInfo(stakingVault);
      expect(afterInfo.tierId).to.equal(requestedTierId);

      const connection = await vaultHub.vaultConnection(stakingVault);
      expect(connection.shareLimit).to.equal(requestedShareLimit);
      expect(connection.reserveRatioBP).to.equal(afterInfo.reserveRatioBP);
      expect(connection.forcedRebalanceThresholdBP).to.equal(afterInfo.forcedRebalanceThresholdBP);
    });

    it("change tier should work with sync mode", async () => {
      // Setup: register group and tier, then move to tier 1 first
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("2000"),
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      const tierId = 1n;
      const initialLimit = ether("1200");

      // Confirm change tier into tier 1
      await dashboard.changeTier(tierId, initialLimit);
      await expect(operatorGrid.connect(nodeOperator).changeTier(stakingVault, tierId, initialLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      // Connection should reflect initial tier params
      const connectionBeforeSync = await vaultHub.vaultConnection(stakingVault);
      expect(connectionBeforeSync.reserveRatioBP).to.equal(2000);
      expect(connectionBeforeSync.forcedRebalanceThresholdBP).to.equal(1800);
      expect(connectionBeforeSync.infraFeeBP).to.equal(500);
      expect(connectionBeforeSync.liquidityFeeBP).to.equal(400);
      expect(connectionBeforeSync.reservationFeeBP).to.equal(100);

      // Update tier parameters via registry and then sync to apply to connection
      const updatedTierParams = {
        shareLimit: ether("2000"),
        reserveRatioBP: 2100,
        forcedRebalanceThresholdBP: 1900,
        infraFeeBP: 550,
        liquidityFeeBP: 420,
        reservationFeeBP: 120,
      };
      await operatorGrid.connect(agentSigner).alterTiers([tierId], [updatedTierParams]);

      // Now sync mode: request the same tier but with a new share limit
      const newLimit = ether("1000");
      expect(await dashboard.changeTier.staticCall(tierId, newLimit)).to.equal(false);
      await dashboard.changeTier(tierId, newLimit);
      await expect(operatorGrid.connect(nodeOperator).changeTier(stakingVault, tierId, newLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const connection = await vaultHub.vaultConnection(stakingVault);
      expect(connection.shareLimit).to.equal(newLimit);
      // Parameters should be updated in VaultHub after sync
      expect(connection.reserveRatioBP).to.equal(updatedTierParams.reserveRatioBP);
      expect(connection.forcedRebalanceThresholdBP).to.equal(updatedTierParams.forcedRebalanceThresholdBP);
      expect(connection.infraFeeBP).to.equal(updatedTierParams.infraFeeBP);
      expect(connection.liquidityFeeBP).to.equal(updatedTierParams.liquidityFeeBP);
      expect(connection.reservationFeeBP).to.equal(updatedTierParams.reservationFeeBP);

      const info = await operatorGrid.vaultInfo(stakingVault);
      expect(info.tierId).to.equal(tierId);
    });

    it("reverts when changing to default tier (non-sync)", async () => {
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("2000"),
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      // Move to tier 1 first
      await dashboard.changeTier(1n, ether("1000"));
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, 1n, ether("1000"));

      // Try to change to default tier (0) → should revert
      await expect(
        operatorGrid.connect(nodeOperator).changeTier(stakingVault, 0n, ether("1000")),
      ).to.be.revertedWithCustomError(operatorGrid, "CannotChangeToDefaultTier");
    });
  });

  describe("Update share limit logic", () => {
    let agentSigner: HardhatEthersSigner;

    beforeEach(async () => {
      agentSigner = await ctx.getSigner("agent");
    });

    it("update share limit should work", async () => {
      // Default tier: owner can update share limit directly
      const before = await vaultHub.vaultConnection(stakingVault);
      const decreased = before.shareLimit - 1n;

      await expect(dashboard.updateShareLimit(decreased)).to.emit(vaultHub, "VaultConnectionUpdated");

      const after = await vaultHub.vaultConnection(stakingVault);
      expect(after.shareLimit).to.equal(decreased);
    });

    it("increasing share limit in non-default tier requires both confirmations", async () => {
      // Register group and move to tier 1
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("3000"),
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      // Change tier to 1 with initial limit 1000
      await dashboard.changeTier(1n, ether("1000"));
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, 1n, ether("1000"));

      // Try to increase to 1500 → first confirmation by owner via Dashboard returns false
      const increaseTo = ether("1200");
      expect(await dashboard.updateShareLimit.staticCall(increaseTo)).to.equal(false);
      await dashboard.updateShareLimit(increaseTo);

      // Second confirmation by node operator via OperatorGrid finalizes
      await expect(operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, increaseTo)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      const after = await vaultHub.vaultConnection(stakingVault);
      expect(after.shareLimit).to.equal(increaseTo);
    });

    it("allows decreasing share limit in non-default tier by vault owner only", async () => {
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("3000"),
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await dashboard.changeTier(1n, ether("1200"));
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, 1n, ether("1200"));

      const current = await vaultHub.vaultConnection(stakingVault);
      const decreased = current.shareLimit - 100n;

      // Node operator cannot decrease directly
      await expect(
        operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, decreased),
      ).to.be.revertedWithCustomError(operatorGrid, "NotAuthorized");

      // Owner (Dashboard) can decrease by itself
      await expect(dashboard.updateShareLimit(decreased)).to.emit(vaultHub, "VaultConnectionUpdated");

      const after = await vaultHub.vaultConnection(stakingVault);
      expect(after.shareLimit).to.equal(decreased);
    });

    it("reverts when requested share limit equals current", async () => {
      const current = await vaultHub.vaultConnection(stakingVault);
      await expect(dashboard.updateShareLimit(current.shareLimit)).to.be.revertedWithCustomError(
        operatorGrid,
        "ShareLimitAlreadySet",
      );
    });

    it("reverts when requested share limit exceeds tier limit", async () => {
      // Default tier case
      const info = await operatorGrid.vaultInfo(stakingVault);
      const over = info.shareLimit + 1n;
      await expect(dashboard.updateShareLimit(over)).to.be.revertedWithCustomError(
        operatorGrid,
        "RequestedShareLimitTooHigh",
      );
    });
  });
});
