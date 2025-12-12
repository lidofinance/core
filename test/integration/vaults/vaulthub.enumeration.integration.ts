import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingVault, VaultHub } from "typechain-types";

import { ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub enumeration functions", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let vaultHub: VaultHub;

  let owner1: HardhatEthersSigner;
  let owner2: HardhatEthersSigner;
  let owner3: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    vaultHub = ctx.contracts.vaultHub;

    [owner1, owner2, owner3, nodeOperator] = await ethers.getSigners();
  });

  let baseVaultsCount: bigint;

  beforeEach(async () => {
    snapshot = await Snapshot.take();
    baseVaultsCount = await vaultHub.vaultsCount();
  });
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("VaultHub: vaultsCount", () => {
    it("returns existing count when no vaults are connected", async () => {
      expect(await vaultHub.vaultsCount()).to.equal(baseVaultsCount);
    });

    it("returns 1 when one vault is connected", async () => {
      const { dashboard } = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner1,
        nodeOperator,
        nodeOperator,
      );

      await dashboard.connect(owner1).fund({ value: ether("1") });

      expect(await vaultHub.vaultsCount()).to.equal(baseVaultsCount + 1n);
    });

    it("returns correct count when multiple vaults are connected", async () => {
      for (let i = 0; i < 3; i++) {
        const owner = [owner1, owner2, owner3][i];
        const { dashboard } = await createVaultWithDashboard(
          ctx,
          ctx.contracts.stakingVaultFactory,
          owner,
          nodeOperator,
          nodeOperator,
        );

        await dashboard.connect(owner).fund({ value: ether("1") });
      }

      expect(await vaultHub.vaultsCount()).to.equal(baseVaultsCount + 3n);
    });

    it("decreases count when vault is disconnected", async () => {
      const vault1Info = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner1,
        nodeOperator,
        nodeOperator,
      );
      await vault1Info.dashboard.connect(owner1).fund({ value: ether("1") });

      const vault2Info = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner2,
        nodeOperator,
        nodeOperator,
      );
      await vault2Info.dashboard.connect(owner2).fund({ value: ether("1") });

      expect(await vaultHub.vaultsCount()).to.equal(baseVaultsCount + 2n);

      await vault1Info.dashboard.connect(owner1).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, vault1Info.stakingVault, { waitForNextRefSlot: true });

      expect(await vaultHub.vaultsCount()).to.equal(baseVaultsCount + 1n);

      const vault3Info = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner3,
        nodeOperator,
        nodeOperator,
      );
      await vault3Info.dashboard.connect(owner3).fund({ value: ether("1") });

      expect(await vaultHub.vaultsCount()).to.equal(baseVaultsCount + 2n);
    });
  });

  describe("vaultByIndex", () => {
    it("reverts when index is 0 (reserved index)", async () => {
      await expect(vaultHub.vaultByIndex(0)).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts when index is out of bounds", async () => {
      const { dashboard } = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner1,
        nodeOperator,
        nodeOperator,
      );

      await dashboard.connect(owner1).fund({ value: ether("1") });

      await expect(vaultHub.vaultByIndex(baseVaultsCount + 2n)).to.be.reverted;
      await expect(vaultHub.vaultByIndex(baseVaultsCount + 1000n)).to.be.reverted;
    });

    it("returns correct vault address by index", async () => {
      const vaults: StakingVault[] = [];

      for (let i = 0; i < 3; i++) {
        const owner = [owner1, owner2, owner3][i];
        const { stakingVault, dashboard } = await createVaultWithDashboard(
          ctx,
          ctx.contracts.stakingVaultFactory,
          owner,
          nodeOperator,
          nodeOperator,
        );

        await dashboard.connect(owner).fund({ value: ether("1") });
        vaults.push(stakingVault);
      }

      for (let i = 0; i < vaults.length; i++) {
        const index = baseVaultsCount + BigInt(i + 1);
        const vaultAddress = await vaultHub.vaultByIndex(index);
        expect(vaultAddress).to.equal(await vaults[i].getAddress());
      }
    });

    it("handles vault index changes after disconnection", async () => {
      const existingVaults = await vaultHub.vaultsCount();
      const vault1Info = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner1,
        nodeOperator,
        nodeOperator,
      );
      await vault1Info.dashboard.connect(owner1).fund({ value: ether("1") });

      const vault2Info = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner2,
        nodeOperator,
        nodeOperator,
      );
      await vault2Info.dashboard.connect(owner2).fund({ value: ether("1") });

      const vault3Info = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner3,
        nodeOperator,
        nodeOperator,
      );
      await vault3Info.dashboard.connect(owner3).fund({ value: ether("1") });

      const vault1Address = await vault1Info.stakingVault.getAddress();
      const vault2Address = await vault2Info.stakingVault.getAddress();
      const vault3Address = await vault3Info.stakingVault.getAddress();

      expect(await vaultHub.vaultByIndex(existingVaults + 1n)).to.equal(vault1Address);
      expect(await vaultHub.vaultByIndex(existingVaults + 2n)).to.equal(vault2Address);
      expect(await vaultHub.vaultByIndex(existingVaults + 3n)).to.equal(vault3Address);

      await vault1Info.dashboard.connect(owner1).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, vault1Info.stakingVault, { waitForNextRefSlot: true });

      expect(await vaultHub.vaultsCount()).to.equal(existingVaults + 2n);
      expect(await vaultHub.vaultByIndex(existingVaults + 1n)).to.equal(vault3Address);
      expect(await vaultHub.vaultByIndex(existingVaults + 2n)).to.equal(vault2Address);
    });
  });
});
