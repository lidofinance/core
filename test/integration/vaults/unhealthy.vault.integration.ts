import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, StakingVault } from "typechain-types";

import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: Unhealthy vault", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    const { stakingVaultFactory, vaultHub } = ctx.contracts;
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator, stranger] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);

    // Going to unhealthy state
    await dashboard.fund({ value: ether("9") }); // TV = 10 ETH
    await dashboard.mintShares(owner, await dashboard.remainingMintingCapacityShares(0n));

    // Slash 1 ETH
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("9"),
      slashingReserve: ether("1"),
      waitForNextRefSlot: true,
    });

    expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Force rebalance", () => {
    it("Anyone can force rebalance unhealthy vault", async () => {
      const { vaultHub, lido } = ctx.contracts;

      const recordBefore = await vaultHub.vaultRecord(stakingVault);
      const obligationsBefore = await vaultHub.obligations(stakingVault);

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      expect(obligationsBefore.sharesToBurn).to.be.gt(0n);

      const availableBalance = await ethers.provider.getBalance(stakingVault);
      const sharesToRebalance = await lido.getSharesByPooledEth(availableBalance);
      const expectedShares =
        sharesToRebalance < obligationsBefore.sharesToBurn ? sharesToRebalance : obligationsBefore.sharesToBurn;

      await expect(vaultHub.connect(stranger).forceRebalance(stakingVault))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(stakingVault, expectedShares, await lido.getPooledEthBySharesRoundUp(expectedShares));

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;

      const recordAfter = await vaultHub.vaultRecord(stakingVault);
      expect(recordAfter.liabilityShares).to.be.lt(recordBefore.liabilityShares);
    });

    it("Force rebalance with insufficient balance", async () => {
      const { vaultHub, lido } = ctx.contracts;

      // Set vault balance to 1 ETH
      await setBalance(await stakingVault.getAddress(), ether("1"));

      const obligationsBefore = await vaultHub.obligations(stakingVault);
      const availableBalance = await ethers.provider.getBalance(stakingVault);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      expect(availableBalance).to.equal(ether("1"));
      expect(obligationsBefore.sharesToBurn).to.be.gt(0n);

      // Force rebalance with partial balance
      await vaultHub.connect(stranger).forceRebalance(stakingVault);

      // Vault should still be unhealthy because we could only partially rebalance
      const obligationsAfter = await vaultHub.obligations(stakingVault);
      const expectedSharesToBurn = obligationsBefore.sharesToBurn - (await lido.getSharesByPooledEth(availableBalance));
      // Allow small rounding difference (up to 10 wei) due to ETH/shares conversion
      expect(obligationsAfter.sharesToBurn).to.be.closeTo(expectedSharesToBurn, 10n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
    });

    it("Force rebalance reverts when no funds", async () => {
      const { vaultHub } = ctx.contracts;

      // Set vault balance to 0
      await setBalance(await stakingVault.getAddress(), 0n);

      await expect(vaultHub.connect(stranger).forceRebalance(stakingVault))
        .to.be.revertedWithCustomError(vaultHub, "NoFundsForForceRebalance")
        .withArgs(stakingVault);
    });

    it("Force rebalance reverts when no reason (Healthy vault)", async () => {
      const { vaultHub, stakingVaultFactory } = ctx.contracts;

      // Create a healthy vault
      const { stakingVault: healthyVault, dashboard: healthyDashboard } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
      );

      await healthyDashboard.connect(owner).fund({ value: ether("10") });
      await healthyDashboard.connect(owner).mintShares(owner, ether("1"));

      expect(await vaultHub.isVaultHealthy(healthyVault)).to.be.true;

      await expect(vaultHub.connect(stranger).forceRebalance(healthyVault))
        .to.be.revertedWithCustomError(vaultHub, "NoReasonForForceRebalance")
        .withArgs(healthyVault);
    });

    it("Force rebalance does not settle Lido fees", async () => {
      const { vaultHub } = ctx.contracts;

      // Report with 1 ETH of Lido fees
      await reportVaultDataWithProof(ctx, stakingVault, {
        slashingReserve: ether("1"),
        cumulativeLidoFees: ether("1"),
        waitForNextRefSlot: true,
      });

      // Get initial state before force rebalance
      const recordBefore = await vaultHub.vaultRecord(stakingVault);
      expect(recordBefore.settledLidoFees).to.equal(0n);
      expect(recordBefore.cumulativeLidoFees).to.equal(ether("1"));
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;

      // Force rebalance
      await vaultHub.connect(stranger).forceRebalance(stakingVault);

      // Check that fees were NOT settled - settledLidoFees should remain unchanged
      const recordAfter = await vaultHub.vaultRecord(stakingVault);
      expect(recordAfter.settledLidoFees).to.equal(0n);
      expect(recordAfter.cumulativeLidoFees).to.equal(ether("1"));
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
    });
  });
});
