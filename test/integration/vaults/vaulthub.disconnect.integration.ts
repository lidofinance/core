import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, StakingVault } from "typechain-types";

import {
  changeTier,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let dao: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let tierId: bigint;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);
    [, owner, nodeOperator, dao] = await ethers.getSigners();

    await setUpOperatorGrid(ctx, [nodeOperator]);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);

    tierId = await changeTier(ctx, dashboard, owner, nodeOperator);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Disconnect initiation", () => {
    describe("Voluntary", () => {
      it("Fresh vault can disconnect", async () => {
        const { vaultHub, operatorGrid } = ctx.contracts;

        await expect(dashboard.voluntaryDisconnect())
          .to.emit(vaultHub, "VaultDisconnectInitiated")
          .withArgs(stakingVault);

        expect((await operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.equal(tierId);
        expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
        expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
      });

      it("Vault with liability can disconnect after liability is paid", async () => {
        const { vaultHub, lido } = ctx.contracts;

        await dashboard.fund({ value: ether("1.5") });

        await dashboard.mintStETH(owner, ether("1"));
        await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

        await lido.connect(owner).approve(dashboard, ether("1"));
        await dashboard.burnStETH(ether("1"));
        await reportVaultDataWithProof(ctx, stakingVault);

        await expect(dashboard.voluntaryDisconnect())
          .to.emit(vaultHub, "VaultDisconnectInitiated")
          .withArgs(stakingVault);

        expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
        expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
      });
    });

    describe("Forced", () => {
      it("Fresh vault", async () => {
        const { vaultHub } = ctx.contracts;

        await vaultHub.connect(await ctx.getSigner("agent")).grantRole(await vaultHub.VAULT_MASTER_ROLE(), dao);

        await expect(vaultHub.connect(dao).disconnect(stakingVault))
          .to.emit(vaultHub, "VaultDisconnectInitiated")
          .withArgs(stakingVault);

        expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
        expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
      });

      it("Vault with balance more than total value", async () => {
        const { vaultHub } = ctx.contracts;

        await reportVaultDataWithProof(ctx, stakingVault, { totalValue: 100n, cumulativeLidoFees: 200n });
        await setBalance(await stakingVault.getAddress(), ether("1.5"));

        await vaultHub.connect(await ctx.getSigner("agent")).grantRole(await vaultHub.VAULT_MASTER_ROLE(), dao);

        await expect(vaultHub.connect(dao).disconnect(stakingVault))
          .to.emit(vaultHub, "VaultDisconnectInitiated")
          .withArgs(stakingVault);
      });
    });
  });

  describe("Disconnect completion", () => {
    beforeEach(async () => await dashboard.connect(owner).voluntaryDisconnect());

    it("Vault brings report and disconnects", async () => {
      const { vaultHub, operatorGrid } = ctx.contracts;

      await expect(reportVaultDataWithProof(ctx, stakingVault))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      expect((await operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.equal(0n);
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
      expect(await vaultHub.locked(stakingVault)).to.be.equal(0n);
    });

    it("Vault brings report and disconnects not paying last fees", async () => {
      const { vaultHub, locator } = ctx.contracts;
      const treasury = await locator.treasury();

      const treasuryBalance = await ethers.provider.getBalance(treasury);

      await expect(reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: 100n }))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
      expect(await vaultHub.locked(stakingVault)).to.be.equal(0n);

      expect(await ethers.provider.getBalance(treasury)).to.be.equal(treasuryBalance);
    });
  });

  describe("Disconnect abortion", () => {
    beforeEach(async () => await dashboard.connect(owner).voluntaryDisconnect());

    it("Vault brings report with slashing reserve", async () => {
      const { vaultHub, operatorGrid } = ctx.contracts;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { slashingReserve: ether("1") }))
        .to.emit(vaultHub, "VaultDisconnectAborted")
        .withArgs(stakingVault, ether("1"));

      expect((await operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.equal(tierId);
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
      expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
      expect(await dashboard.minimalReserve()).to.be.equal(ether("1"));
    });
  });

  describe("Special cases", () => {
    it("Vault can't disconnect if it initiated disconnect this frame of the oracle", async () => {
      const { vaultHub, lido } = ctx.contracts;

      const funding = ether("1.5");
      const shares = await lido.getSharesByPooledEth(funding);
      await dashboard.fund({ value: funding });
      await dashboard.mintShares(owner, shares);
      const { reportTimestamp, reportRefSlot } = await waitNextAvailableReportTime(ctx);

      await lido.connect(owner).approve(dashboard, funding);
      await dashboard.burnShares(shares);

      // vault slashes and hastily disconnects
      await dashboard.voluntaryDisconnect();
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;

      await expect(
        reportVaultDataWithProof(ctx, stakingVault, {
          liabilityShares: shares,
          // report data does not contain slashing reserve because oracle has not seen it yet
          reportTimestamp,
          reportRefSlot,
        }),
      ).to.not.emit(vaultHub, "VaultDisconnectCompleted");

      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
    });
  });
});
