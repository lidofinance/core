import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, Lido, StakingVault, VaultHub } from "typechain-types";

import { impersonate } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub.transferAndBurnShares", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;

  let vaultHub: VaultHub;
  let dashboard: Dashboard;
  let lido: Lido;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    const dashboardSigner = await impersonate(dashboard, ether("100"));

    vaultHub = ctx.contracts.vaultHub.connect(dashboardSigner);
    lido = ctx.contracts.lido;
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("VaultHub: transferAndBurnShares", () => {
    beforeEach(async () => {
      await dashboard.connect(owner).fund({ value: ether("100") });
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      await dashboard.connect(owner).mintShares(dashboard, ether("10"));
    });

    it("successfully transfers and burns shares", async () => {
      const sharesToBurn = ether("1");

      const tokenAmount = await lido.getPooledEthByShares(sharesToBurn);
      await lido.connect(vaultHub.runner!).approve(vaultHub, tokenAmount);

      const liabilitySharesBefore = await vaultHub.liabilityShares(stakingVault);
      const dashboardSharesBefore = await lido.sharesOf(dashboard);
      const vaultHubSharesBefore = await lido.sharesOf(vaultHub);

      await expect(vaultHub.transferAndBurnShares(stakingVault, sharesToBurn))
        .to.emit(lido, "TransferShares")
        .and.to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, sharesToBurn);

      const liabilitySharesAfter = await vaultHub.liabilityShares(stakingVault);
      const dashboardSharesAfter = await lido.sharesOf(dashboard);
      const vaultHubSharesAfter = await lido.sharesOf(vaultHub);

      expect(dashboardSharesBefore - dashboardSharesAfter).to.equal(sharesToBurn);
      expect(vaultHubSharesAfter).to.equal(vaultHubSharesBefore);
      expect(liabilitySharesBefore - liabilitySharesAfter).to.equal(sharesToBurn);
    });

    it("updates stETH balances correctly", async () => {
      const sharesToBurn = ether("1.5");

      const tokenAmount = await lido.getPooledEthByShares(sharesToBurn);
      await lido.connect(vaultHub.runner!).approve(vaultHub, tokenAmount);

      const dashboardBalanceBefore = await lido.balanceOf(dashboard);
      const vaultHubBalanceBefore = await lido.balanceOf(vaultHub);
      const expectedBurnAmount = await lido.getPooledEthByShares(sharesToBurn);

      await vaultHub.transferAndBurnShares(stakingVault, sharesToBurn);

      const dashboardBalanceAfter = await lido.balanceOf(dashboard);
      const vaultHubBalanceAfter = await lido.balanceOf(vaultHub);

      expect(dashboardBalanceBefore - dashboardBalanceAfter).to.be.closeTo(expectedBurnAmount, 10n);
      expect(vaultHubBalanceAfter).to.be.closeTo(vaultHubBalanceBefore, 10n);
    });

    it("updates liability correctly after burn", async () => {
      const sharesToBurn = ether("0.5");

      const tokenAmount = await lido.getPooledEthByShares(sharesToBurn);
      await lido.connect(vaultHub.runner!).approve(vaultHub, tokenAmount);

      const recordBefore = await vaultHub.vaultRecord(stakingVault);
      const liabilityBefore = recordBefore.liabilityShares;

      await vaultHub.transferAndBurnShares(stakingVault, sharesToBurn);

      const recordAfter = await vaultHub.vaultRecord(stakingVault);
      const liabilityAfter = recordAfter.liabilityShares;

      expect(liabilityBefore - liabilityAfter).to.equal(sharesToBurn);
    });

    it("handles multiple burns", async () => {
      const firstBurn = ether("0.5");
      const secondBurn = ether("0.8");
      const totalBurn = firstBurn + secondBurn;

      const tokenAmount = await lido.getPooledEthByShares(totalBurn);
      await lido.connect(vaultHub.runner!).approve(vaultHub, tokenAmount);

      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);
      const dashboardSharesBefore = await lido.sharesOf(dashboard);

      await vaultHub.transferAndBurnShares(stakingVault, firstBurn);
      await vaultHub.transferAndBurnShares(stakingVault, secondBurn);

      const liabilityAfter = await vaultHub.liabilityShares(stakingVault);
      const dashboardSharesAfter = await lido.sharesOf(dashboard);

      expect(liabilityBefore - liabilityAfter).to.equal(totalBurn);
      expect(dashboardSharesBefore - dashboardSharesAfter).to.equal(totalBurn);
    });

    it("handles small amounts (1 wei)", async () => {
      const smallAmount = 1n;

      const tokenAmount = await lido.getPooledEthByShares(smallAmount);
      await lido.connect(vaultHub.runner!).approve(vaultHub, tokenAmount);

      const liabilityBefore = await vaultHub.liabilityShares(stakingVault);

      await vaultHub.transferAndBurnShares(stakingVault, smallAmount);

      const liabilityAfter = await vaultHub.liabilityShares(stakingVault);

      expect(liabilityBefore - liabilityAfter).to.equal(smallAmount);
    });

    it("handles exact liability amount", async () => {
      const exactLiability = await vaultHub.liabilityShares(stakingVault);

      const tokenAmount = await lido.getPooledEthByShares(exactLiability);
      await lido.connect(vaultHub.runner!).approve(vaultHub, tokenAmount);

      await expect(vaultHub.transferAndBurnShares(stakingVault, exactLiability))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, exactLiability);

      const liabilityAfter = await vaultHub.liabilityShares(stakingVault);
      expect(liabilityAfter).to.equal(0n);
    });
  });
});
