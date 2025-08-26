import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import {
  calculateLockedValue,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: Dashboard ", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

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
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Minting", () => {
    it("Minting capacity is 0 on fresh vault", async () => {
      expect(await dashboard.totalMintingCapacityShares()).to.be.equal(0n);
      expect(await dashboard.remainingMintingCapacityShares(0n)).to.be.equal(0n);
    });

    it("Minting capacity increase with total value", async () => {
      const { vaultHub } = ctx.contracts;

      const totalMintingCapacityShares0 = await dashboard.totalMintingCapacityShares();
      expect(totalMintingCapacityShares0).to.be.equal(0n);
      const remainingMintingCapacityShares1 = await dashboard.remainingMintingCapacityShares(ether("1"));

      // reserve < minimalReserve
      await dashboard.fund({ value: ether("1") });
      const totalMintingCapacityShares1 = await dashboard.totalMintingCapacityShares();
      expect(
        await calculateLockedValue(ctx, stakingVault, { liabilityShares: totalMintingCapacityShares1 }),
      ).to.be.closeTo(await vaultHub.maxLockableValue(stakingVault), 2n);
      expect(totalMintingCapacityShares1).to.be.equal(remainingMintingCapacityShares1);

      // reserve > minimalReserve
      const remainingMintingCapacityShares10 = await dashboard.remainingMintingCapacityShares(ether("10"));
      await dashboard.fund({ value: ether("10") });
      const totalMintingCapacityShares10 = await dashboard.totalMintingCapacityShares();
      expect(
        await calculateLockedValue(ctx, stakingVault, { liabilityShares: totalMintingCapacityShares10 }),
      ).to.be.closeTo(await vaultHub.maxLockableValue(stakingVault), 2n);
      expect(totalMintingCapacityShares10).to.be.equal(remainingMintingCapacityShares10);
    });

    it("Minting capacity decreases with unsettled fees", async () => {
      const { vaultHub } = ctx.contracts;
      expect(await dashboard.totalMintingCapacityShares()).to.be.equal(0n);
      expect(await dashboard.remainingMintingCapacityShares(0n)).to.be.equal(0n);

      await reportVaultDataWithProof(ctx, stakingVault, {
        cumulativeLidoFees: ether("1"),
        waitForNextRefSlot: true,
      });

      expect(await dashboard.totalMintingCapacityShares()).to.be.equal(0n);
      expect(await dashboard.remainingMintingCapacityShares(0n)).to.be.equal(0n);

      await dashboard.fund({ value: ether("10") });

      expect(await vaultHub.maxLockableValue(stakingVault)).to.be.equal(ether("10"));
      const totalMintingCapacityShares10 = await dashboard.totalMintingCapacityShares();
      expect(
        await calculateLockedValue(ctx, stakingVault, { liabilityShares: totalMintingCapacityShares10 }),
      ).to.be.closeTo(await vaultHub.maxLockableValue(stakingVault), 2n);
    });

    it("You can mint StETH if you have funded the vault", async () => {
      const vaultHub = ctx.contracts.vaultHub;
      // reserve < minimalReserve
      await dashboard.fund({ value: ether("1") });

      await expect(dashboard.mintShares(owner, ether("0.1")))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(
          stakingVault,
          ether("0.1"),
          await calculateLockedValue(ctx, stakingVault, { liabilitySharesIncrease: ether("0.1") }),
        );

      expect(await vaultHub.locked(stakingVault)).to.be.equal(await calculateLockedValue(ctx, stakingVault));

      // reserve > minimalReserve
      await dashboard.fund({ value: ether("100") });

      await expect(dashboard.mintShares(owner, ether("10")))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(
          stakingVault,
          ether("10"),
          await calculateLockedValue(ctx, stakingVault, { liabilitySharesIncrease: ether("10") }),
        );
    });
  });
});
