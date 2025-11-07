import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, OperatorGrid, StakingVault, VaultHub } from "typechain-types";

import { ether, MAX_SANE_SETTLED_GROWTH } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";
import { advanceChainTime, days } from "lib/time";

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
      const beforeInfo = await operatorGrid.vaultTierInfo(stakingVault);
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

      const afterInfo = await operatorGrid.vaultTierInfo(stakingVault);
      expect(afterInfo.tierId).to.equal(requestedTierId);

      const connection = await vaultHub.vaultConnection(stakingVault);
      expect(connection.shareLimit).to.equal(requestedShareLimit);
      expect(connection.reserveRatioBP).to.equal(afterInfo.reserveRatioBP);
      expect(connection.forcedRebalanceThresholdBP).to.equal(afterInfo.forcedRebalanceThresholdBP);
    });

    it("sync tier should work", async () => {
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

      // First confirmation from vault owner via Dashboard → returns false (not yet confirmed)
      expect(await dashboard.syncTier.staticCall()).to.equal(false);
      await dashboard.syncTier();

      // Second confirmation from node operator → completes and updates connection
      await expect(operatorGrid.connect(nodeOperator).syncTier(stakingVault)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      // Connection should now reflect updated tier params
      const connectionAfterSync = await vaultHub.vaultConnection(stakingVault);
      expect(connectionAfterSync.reserveRatioBP).to.equal(2100);
      expect(connectionAfterSync.forcedRebalanceThresholdBP).to.equal(1900);
      expect(connectionAfterSync.infraFeeBP).to.equal(550);
      expect(connectionAfterSync.liquidityFeeBP).to.equal(420);
      expect(connectionAfterSync.reservationFeeBP).to.equal(120);

      // Share limit should remain unchanged after sync
      expect(connectionAfterSync.shareLimit).to.equal(initialLimit);
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

    it("changing share limit in non-default tier requires both confirmations", async () => {
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

      // Try to increase to 1200 → first confirmation by owner via Dashboard returns false
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

    it("reverts when requested share limit equals current", async () => {
      const current = await vaultHub.vaultConnection(stakingVault);
      await expect(dashboard.updateShareLimit(current.shareLimit)).to.be.revertedWithCustomError(
        operatorGrid,
        "ShareLimitAlreadySet",
      );
    });

    it("reverts when requested share limit exceeds tier limit", async () => {
      // Default tier case
      const info = await operatorGrid.vaultTierInfo(stakingVault);
      const over = info.shareLimit + 1n;
      await expect(dashboard.updateShareLimit(over)).to.be.revertedWithCustomError(
        operatorGrid,
        "RequestedShareLimitTooHigh",
      );
    });

    it("requires fresh report before updating connection (stale report reverts)", async () => {
      // Ensure we are in a known tier and connected
      const current = await vaultHub.vaultConnection(stakingVault);
      let newLimit = current.shareLimit - 1n;

      expect(await dashboard.updateShareLimit.staticCall(newLimit)).to.equal(false);
      await dashboard.updateShareLimit(newLimit);

      // Second confirmation by node operator via OperatorGrid finalizes
      await expect(operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, newLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );

      await advanceChainTime(days(3n)); // REPORT_FRESHNESS_DELTA = 2 days

      newLimit = newLimit - 1n;

      expect(await dashboard.updateShareLimit.staticCall(newLimit)).to.equal(false);
      await dashboard.updateShareLimit(newLimit);

      await expect(
        operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, newLimit),
      ).to.be.revertedWithCustomError(vaultHub, "VaultReportStale");
    });
  });

  describe("Jail Status", () => {
    let agentSigner: HardhatEthersSigner;

    beforeEach(async () => {
      agentSigner = await ctx.getSigner("agent");
    });

    it("Vault in jail can't mint stETH", async () => {
      // Put vault in jail before disconnecting
      await operatorGrid.connect(agentSigner).setVaultJailStatus(stakingVault, true);
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // Verify vault is jailed and can't mint normally
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");
    });

    it("Vault can mint again after being removed from jail", async () => {
      await operatorGrid.connect(agentSigner).setVaultJailStatus(stakingVault, true);
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");

      await operatorGrid.connect(agentSigner).setVaultJailStatus(stakingVault, false);
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.false;
      await expect(dashboard.mintShares(owner, 100n)).to.not.be.reverted;
    });

    it("Changing tier doesn't affect jail status", async () => {
      // Register a group and tiers for tier changing
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("1000"),
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
        {
          shareLimit: ether("2000"),
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      // Put vault in jail before changing tier
      await operatorGrid.connect(agentSigner).setVaultJailStatus(stakingVault, true);
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // Verify vault is jailed and can't mint normally
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");

      // Get initial tier
      const initialVaultInfo = await operatorGrid.vaultTierInfo(stakingVault);
      expect(initialVaultInfo.tierId).to.equal(0); // Should be default tier

      // Change tier from default (0) to tier 1
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, 1, ether("1000"));
      await dashboard.connect(owner).changeTier(1, ether("1000"));

      // Verify tier changed
      const updatedVaultInfo = await operatorGrid.vaultTierInfo(stakingVault);
      expect(updatedVaultInfo.tierId).to.equal(1);

      // Verify jail status is preserved after tier change
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // Verify minting still fails without bypass after tier change
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");
    });

    it("Disconnect and connect back preserves jail status", async () => {
      // Put vault in jail before disconnecting
      await operatorGrid.connect(agentSigner).setVaultJailStatus(stakingVault, true);
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // Verify vault is jailed and can't mint normally
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");

      // Get initial connection status
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

      // Disconnect vault (ensure fresh report first)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: await dashboard.totalValue(),
        waitForNextRefSlot: true,
      });
      await dashboard.connect(owner).voluntaryDisconnect();

      // Verify disconnect is pending
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

      // Vault should still be jailed during disconnect process
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // Complete disconnect by reporting with zero liability shares
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: await dashboard.totalValue(),
        liabilityShares: 0n,
      });

      // Vault should still be jailed after disconnect
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

      await dashboard.connect(owner).correctSettledGrowth(0, MAX_SANE_SETTLED_GROWTH);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0, MAX_SANE_SETTLED_GROWTH);

      // Reconnect vault
      await dashboard.connect(owner).reconnectToVaultHub();

      // Verify vault is reconnected
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

      // Verify vault is still jailed after reconnection
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // Verify jail restrictions still apply after reconnection
      await dashboard.connect(owner).fund({ value: ether("2") });
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");
    });

    it("Jail blocks only minting and allows other operations", async () => {
      const { lido } = ctx.contracts;

      // Setup: Mint some shares first to prepare for testing burns and rebalances
      await dashboard.mintShares(owner, ether("1"));
      const initialLiabilityShares = await vaultHub.vaultRecord(stakingVault).then((r) => r.liabilityShares);
      expect(initialLiabilityShares).to.be.gt(0n);

      // Put vault in jail
      await operatorGrid.connect(agentSigner).setVaultJailStatus(stakingVault, true);
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // 1. Verify minting is blocked
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");

      // 2. Verify burning is NOT blocked
      const sharesToBurn = ether("0.1");
      await lido.connect(owner).approve(dashboard, 10n * sharesToBurn);
      await expect(dashboard.connect(owner).burnShares(sharesToBurn)).to.not.be.reverted;

      // 3. Verify withdrawals are NOT blocked
      const withdrawAmount = ether("0.1");
      await expect(dashboard.withdraw(owner, withdrawAmount)).to.not.be.reverted;

      // 4. Verify rebalancing is NOT blocked
      // Add more funds to enable rebalancing
      await dashboard.fund({ value: ether("2") });
      const sharesToRebalance = await vaultHub.vaultRecord(stakingVault).then((r) => r.liabilityShares);
      await expect(dashboard.rebalanceVaultWithShares(sharesToRebalance)).to.not.be.reverted;

      // 5. Verify lazy reports are NOT blocked
      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: await dashboard.totalValue() })).to.not.be
        .reverted;

      // 6. Verify disconnect is NOT blocked by jail status
      // Ensure fresh report first
      await reportVaultDataWithProof(ctx, stakingVault, {
        waitForNextRefSlot: true,
        totalValue: await dashboard.totalValue(),
      });
      await expect(dashboard.connect(owner).voluntaryDisconnect()).to.not.be.reverted;

      // Verify disconnect was initiated successfully
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;

      // Verify disconnect is completed
      await expect(reportVaultDataWithProof(ctx, stakingVault))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);
    });
  });
});
