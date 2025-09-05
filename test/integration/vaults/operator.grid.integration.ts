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
  reportVaultDataWithProof,
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

  describe("Jail Status Integration Tests", () => {
    let agentSigner: HardhatEthersSigner;

    beforeEach(async () => {
      agentSigner = await ctx.getSigner("agent");
    });

    it("changing tier doesn't affect jail status", async () => {
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
      const initialVaultInfo = await operatorGrid.vaultInfo(stakingVault);
      expect(initialVaultInfo.tierId).to.equal(0); // Should be default tier

      // Change tier from default (0) to tier 1
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, 1, ether("1000"));
      await dashboard.connect(owner).changeTier(1, ether("1000"));

      // Verify tier changed
      const updatedVaultInfo = await operatorGrid.vaultInfo(stakingVault);
      expect(updatedVaultInfo.tierId).to.equal(1);

      // Verify jail status is preserved after tier change
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // Verify minting still fails without bypass after tier change
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");
    });

    it("disconnect and connect back preserves jail status", async () => {
      // Put vault in jail before disconnecting
      await operatorGrid.connect(agentSigner).setVaultJailStatus(stakingVault, true);
      expect(await operatorGrid.isVaultInJail(stakingVault)).to.be.true;

      // Verify vault is jailed and can't mint normally
      await expect(dashboard.mintShares(owner, 100n)).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");

      // Get initial connection status
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

      // Disconnect vault (ensure fresh report first)
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: await dashboard.totalValue() });
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
  });
});
