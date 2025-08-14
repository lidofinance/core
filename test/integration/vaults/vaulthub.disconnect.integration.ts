import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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

describe("Integration: VaultHub", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let dao: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);
    [, owner, nodeOperator, dao] = await ethers.getSigners();

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Disconnect initiation", () => {
    describe("Voluntary", () => {
      it("Fresh vault", async () => {
        const { vaultHub, operatorGrid } = ctx.contracts;

        const { tierId } = await operatorGrid.vaultInfo(stakingVault);

        await expect(dashboard.connect(owner).voluntaryDisconnect())
          .to.emit(vaultHub, "VaultDisconnectInitiated")
          .withArgs(stakingVault);

        expect((await vaultHub.vaultConnection(stakingVault)).pendingDisconnect).to.be.true;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
        expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
        expect((await operatorGrid.vaultInfo(stakingVault)).tierId).to.be.equal(tierId);
      });

      it("Vault with liability", async () => {});
    });

    describe("Forced", () => {
      it("Fresh vault", async () => {
        const { vaultHub } = ctx.contracts;

        await vaultHub.connect(await ctx.getSigner("agent")).grantRole(await vaultHub.VAULT_MASTER_ROLE(), dao);

        await expect(vaultHub.connect(dao).disconnect(stakingVault))
          .to.emit(vaultHub, "VaultDisconnectInitiated")
          .withArgs(stakingVault);

        expect((await vaultHub.vaultConnection(stakingVault)).pendingDisconnect).to.be.true;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
        expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
      });
    });
  });

  describe("Disconnect completion", () => {
    beforeEach(async () => await dashboard.connect(owner).voluntaryDisconnect());

    it("Vault brings report and disconnects", async () => {
      const { vaultHub } = ctx.contracts;

      await expect(reportVaultDataWithProof(ctx, stakingVault))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      expect((await vaultHub.vaultConnection(stakingVault)).pendingDisconnect).to.be.false;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
      expect(await vaultHub.locked(stakingVault)).to.be.equal(0n);
    });

    it("Vault brings report and disconnects paying last fees", async () => {
      const { vaultHub, locator } = ctx.contracts;
      const treasury = await locator.treasury();

      const treasuryBalance = await ethers.provider.getBalance(treasury);

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") }))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      expect((await vaultHub.vaultConnection(stakingVault)).pendingDisconnect).to.be.false;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
      expect(await vaultHub.locked(stakingVault)).to.be.equal(0n);

      expect(await ethers.provider.getBalance(treasury)).to.be.equal(treasuryBalance + ether("1"));
    });
  });

  describe("Disconnect abortion", () => {
    beforeEach(async () => await dashboard.connect(owner).voluntaryDisconnect());

    it("Vault brings report with slashing reserve", async () => {
      const { vaultHub } = ctx.contracts;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { slashingReserve: ether("1") }))
        .to.emit(vaultHub, "VaultDisconnectAborted")
        .withArgs(stakingVault, ether("1"));

      expect((await vaultHub.vaultConnection(stakingVault)).pendingDisconnect).to.be.false;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
      expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
      expect(await dashboard.minimalReserve()).to.be.equal(ether("1"));
    });
  });
});
