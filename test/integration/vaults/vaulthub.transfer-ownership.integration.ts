import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { certainAddress, ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub.transferVaultOwnership", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  let owner: HardhatEthersSigner;
  let newOwner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Helper function to transfer vault ownership through Dashboard with confirmations
  async function dashboardTransferOwnership(newOwnerAddress: string) {
    await dashboard.connect(owner).transferVaultOwnership(newOwnerAddress);
    await dashboard.connect(nodeOperator).transferVaultOwnership(newOwnerAddress);
  }

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    vaultHub = ctx.contracts.vaultHub;

    [owner, newOwner, nodeOperator, stranger] = await ethers.getSigners();

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("VaultHub: transfer ownership through Dashboard", () => {
    it("allows Dashboard owner to transfer vault ownership to a new owner", async () => {
      const connectionBefore = await vaultHub.vaultConnection(stakingVault);

      expect(connectionBefore.owner).to.equal(await dashboard.getAddress());

      // First call - collects confirmation from owner
      await dashboard.connect(owner).transferVaultOwnership(newOwner.address);

      // Second call - collects confirmation from nodeOperator and executes
      await expect(dashboard.connect(nodeOperator).transferVaultOwnership(newOwner.address))
        .to.emit(vaultHub, "VaultOwnershipTransferred")
        .withArgs(stakingVault, newOwner, dashboard);

      const connectionAfter = await vaultHub.vaultConnection(stakingVault);
      expect(connectionAfter.owner).to.equal(newOwner.address);
    });

    it("vault remains connected to hub after ownership transfer", async () => {
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

      await dashboardTransferOwnership(newOwner.address);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;

      const connection = await vaultHub.vaultConnection(stakingVault);
      expect(connection.vaultIndex).to.be.greaterThan(0);
    });

    it("old owner cannot perform owner-only actions after transfer", async () => {
      await dashboard.fund({ value: ether("1") });
      await dashboardTransferOwnership(newOwner.address);

      await expect(vaultHub.connect(owner).fund(stakingVault, { value: ether("0.1") })).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("New owner can perform owner-only actions after transfer", async () => {
      await dashboard.fund({ value: ether("1") });
      await dashboardTransferOwnership(newOwner.address);

      await expect(vaultHub.connect(newOwner).fund(stakingVault, { value: ether("0.1") })).to.emit(
        vaultHub,
        "VaultInOutDeltaUpdated",
      );

      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      await expect(vaultHub.connect(newOwner).withdraw(stakingVault, newOwner.address, ether("0.1")))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(newOwner.address, ether("0.1"));
    });

    it("Preserves all vault connection parameters during transfer", async () => {
      const connectionBefore = await vaultHub.vaultConnection(stakingVault);

      await dashboardTransferOwnership(newOwner.address);

      const connectionAfter = await vaultHub.vaultConnection(stakingVault);

      expect(connectionAfter.shareLimit).to.equal(connectionBefore.shareLimit);
      expect(connectionAfter.vaultIndex).to.equal(connectionBefore.vaultIndex);
      expect(connectionAfter.disconnectInitiatedTs).to.equal(connectionBefore.disconnectInitiatedTs);
      expect(connectionAfter.reserveRatioBP).to.equal(connectionBefore.reserveRatioBP);
      expect(connectionAfter.forcedRebalanceThresholdBP).to.equal(connectionBefore.forcedRebalanceThresholdBP);
      expect(connectionAfter.infraFeeBP).to.equal(connectionBefore.infraFeeBP);
      expect(connectionAfter.liquidityFeeBP).to.equal(connectionBefore.liquidityFeeBP);
      expect(connectionAfter.reservationFeeBP).to.equal(connectionBefore.reservationFeeBP);
      expect(connectionAfter.beaconChainDepositsPauseIntent).to.equal(connectionBefore.beaconChainDepositsPauseIntent);
    });

    it("Preserves all vault records during transfer", async () => {
      await dashboard.fund({ value: ether("1") });
      await dashboard.mintStETH(owner, ether("0.5"));

      const recordBefore = await vaultHub.vaultRecord(stakingVault);

      await dashboardTransferOwnership(newOwner.address);

      const recordAfter = await vaultHub.vaultRecord(stakingVault);

      expect(recordAfter.liabilityShares).to.equal(recordBefore.liabilityShares);
      expect(recordAfter.maxLiabilityShares).to.equal(recordBefore.maxLiabilityShares);
      expect(recordAfter.minimalReserve).to.equal(recordBefore.minimalReserve);
      expect(recordAfter.redemptionShares).to.equal(recordBefore.redemptionShares);
      expect(recordAfter.cumulativeLidoFees).to.equal(recordBefore.cumulativeLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(recordBefore.settledLidoFees);
      expect(recordAfter.report.totalValue).to.equal(recordBefore.report.totalValue);
      expect(recordAfter.report.inOutDelta).to.equal(recordBefore.report.inOutDelta);
      expect(recordAfter.report.timestamp).to.equal(recordBefore.report.timestamp);
    });

    it("allows transfer to the same owner (no-op)", async () => {
      await dashboardTransferOwnership(owner.address);

      await expect(vaultHub.connect(owner).transferVaultOwnership(stakingVault, owner.address))
        .to.emit(vaultHub, "VaultOwnershipTransferred")
        .withArgs(stakingVault, owner.address, owner.address);

      expect((await vaultHub.vaultConnection(stakingVault)).owner).to.equal(owner.address);
    });

    it("Reverts if new owner is zero address", async () => {
      await expect(
        vaultHub.connect(owner).transferVaultOwnership(stakingVault, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("Reverts if vault address is zero", async () => {
      await expect(
        vaultHub.connect(owner).transferVaultOwnership(ethers.ZeroAddress, newOwner.address),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("Reverts if vault is not connected to hub", async () => {
      const disconnectedVault = certainAddress("disconnected-vault");

      await expect(vaultHub.connect(owner).transferVaultOwnership(disconnectedVault, newOwner.address))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(disconnectedVault);
    });

    it("Reverts if caller is not the current owner", async () => {
      await expect(
        vaultHub.connect(stranger).transferVaultOwnership(stakingVault, newOwner.address),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("reverts if vault is pending disconnect", async () => {
      await dashboardTransferOwnership(owner.address);

      await vaultHub.connect(owner).transferVaultOwnership(stakingVault, dashboard);
      await dashboard.voluntaryDisconnect();

      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;

      await dashboard.connect(owner).transferVaultOwnership(newOwner.address);
      await expect(dashboard.connect(nodeOperator).transferVaultOwnership(newOwner.address))
        .to.be.revertedWithCustomError(vaultHub, "VaultIsDisconnecting")
        .withArgs(stakingVault);
    });

    it("can transfer ownership with active liability shares", async () => {
      await dashboardTransferOwnership(owner.address);

      await vaultHub.connect(owner).fund(stakingVault, { value: ether("2") });
      await vaultHub
        .connect(owner)
        .mintShares(stakingVault, owner, await ctx.contracts.lido.getSharesByPooledEth(ether("1")));

      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);
      expect(liabilityBefore).to.be.greaterThan(0);

      await vaultHub.connect(owner).transferVaultOwnership(stakingVault, newOwner.address);

      const liabilityAfter = await vaultHub.liabilityShares(stakingVault);
      expect(liabilityAfter).to.equal(liabilityBefore);

      expect((await vaultHub.vaultConnection(stakingVault)).owner).to.equal(newOwner.address);
    });

    it("can transfer ownership with unsettled Lido fees", async () => {
      await dashboardTransferOwnership(owner.address);

      await vaultHub.connect(owner).fund(stakingVault, { value: ether("1") });

      await reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: ether("0.1"), waitForNextRefSlot: true });

      const record = await vaultHub.vaultRecord(stakingVault);
      const unsettledFees = record.cumulativeLidoFees - record.settledLidoFees;
      expect(unsettledFees).to.be.greaterThan(0);

      await vaultHub.connect(owner).transferVaultOwnership(stakingVault, newOwner.address);

      const recordAfter = await vaultHub.vaultRecord(stakingVault);
      const unsettledFeesAfter = recordAfter.cumulativeLidoFees - recordAfter.settledLidoFees;
      expect(unsettledFeesAfter).to.equal(unsettledFees);

      expect((await vaultHub.vaultConnection(stakingVault)).owner).to.equal(newOwner.address);
    });

    it("can transfer ownership when vault is unhealthy", async () => {
      await dashboardTransferOwnership(owner.address);

      await vaultHub.connect(owner).fund(stakingVault, { value: ether("2") });
      const shares = await ctx.contracts.lido.getSharesByPooledEth(ether("1"));
      await vaultHub.connect(owner).mintShares(stakingVault, owner, shares);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("0.5"), waitForNextRefSlot: true });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;

      await expect(vaultHub.connect(owner).transferVaultOwnership(stakingVault, newOwner.address))
        .to.emit(vaultHub, "VaultOwnershipTransferred")
        .withArgs(stakingVault, newOwner.address, owner.address);

      expect((await vaultHub.vaultConnection(stakingVault)).owner).to.equal(newOwner.address);
    });
  });
});
