import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, VaultFactory } from "typechain-types";

import { days } from "lib";
import { getProtocolContext, ProtocolContext, setupLidoForVaults } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("VaultFactory New Methods Integration", () => {
  let ctx: ProtocolContext;
  let nodeOperator: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let defaultAdmin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let dashboardImpl: Dashboard;
  let vaultFactory: VaultFactory;

  let originalState: string;
  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();
    originalState = await Snapshot.take();

    [, , , nodeOperator, nodeOperatorManager, defaultAdmin, stranger] = await ethers.getSigners();

    await setupLidoForVaults(ctx);

    // Get contracts from context
    const { vaultHub, lido, wstETH, locator } = ctx.contracts;
    vaultFactory = ctx.contracts.stakingVaultFactory;

    // Deploy Dashboard implementation (for testing setDashboardImpl)
    dashboardImpl = await ethers.deployContract("Dashboard", [lido, wstETH, vaultHub, locator]);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalState));

  describe("createDashboard", () => {
    let mockVaultAddress: string;

    beforeEach(async () => {
      // Use a mock vault address for testing
      mockVaultAddress = ethers.Wallet.createRandom().address;
    });

    it("should create a dashboard with correct parameters", async () => {
      const nodeOperatorFeeBP = 200n;
      const confirmExpiry = days(7n);
      const roleAssignments: never[] = [];

      await expect(
        vaultFactory
          .connect(defaultAdmin)
          .createDashboard(
            mockVaultAddress,
            defaultAdmin.address,
            nodeOperatorManager.address,
            nodeOperatorFeeBP,
            confirmExpiry,
            roleAssignments,
          ),
      )
        .to.emit(vaultFactory, "DashboardCreated")
        .withArgs(
          (dashboardAddress: string) => dashboardAddress !== ZeroAddress,
          mockVaultAddress,
          defaultAdmin.address,
        );
    });

    it("should grant optional role assignments", async () => {
      const nodeOperatorFeeBP = 200n;
      const confirmExpiry = days(7n);

      // Get role from dashboard implementation
      const pauseRole = await dashboardImpl.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE();

      const roleAssignments = [
        {
          role: pauseRole,
          account: nodeOperator.address,
        },
      ];

      await expect(
        vaultFactory
          .connect(defaultAdmin)
          .createDashboard(
            mockVaultAddress,
            defaultAdmin.address,
            nodeOperatorManager.address,
            nodeOperatorFeeBP,
            confirmExpiry,
            roleAssignments,
          ),
      )
        .to.emit(vaultFactory, "DashboardCreated")
        .withArgs(
          (dashboardAddress: string) => dashboardAddress !== ZeroAddress,
          mockVaultAddress,
          defaultAdmin.address,
        );
    });

    it("should emit DashboardCreated event with correct parameters", async () => {
      const nodeOperatorFeeBP = 200n;
      const confirmExpiry = days(7n);
      const roleAssignments: never[] = [];

      await expect(
        vaultFactory
          .connect(defaultAdmin)
          .createDashboard(
            mockVaultAddress,
            defaultAdmin.address,
            nodeOperatorManager.address,
            nodeOperatorFeeBP,
            confirmExpiry,
            roleAssignments,
          ),
      )
        .to.emit(vaultFactory, "DashboardCreated")
        .withArgs(
          (dashboardAddress: string) => dashboardAddress !== ZeroAddress,
          mockVaultAddress,
          defaultAdmin.address,
        );
    });

    it("should work with empty role assignments", async () => {
      const nodeOperatorFeeBP = 200n;
      const confirmExpiry = days(7n);
      const roleAssignments: never[] = [];

      const tx = await vaultFactory
        .connect(defaultAdmin)
        .createDashboard(
          mockVaultAddress,
          defaultAdmin.address,
          nodeOperatorManager.address,
          nodeOperatorFeeBP,
          confirmExpiry,
          roleAssignments,
        );

      await expect(tx).to.emit(vaultFactory, "DashboardCreated");
    });

    it("should allow any address to call createDashboard", async () => {
      const nodeOperatorFeeBP = 200n;
      const confirmExpiry = days(7n);
      const roleAssignments: never[] = [];

      // Test that stranger can call the function
      const tx = await vaultFactory
        .connect(stranger)
        .createDashboard(
          mockVaultAddress,
          defaultAdmin.address,
          nodeOperatorManager.address,
          nodeOperatorFeeBP,
          confirmExpiry,
          roleAssignments,
        );

      await expect(tx).to.emit(vaultFactory, "DashboardCreated");
    });
  });

  describe("setDashboardImpl", () => {
    let newDashboardImpl: Dashboard;

    beforeEach(async () => {
      const { lido, wstETH, vaultHub, locator } = ctx.contracts;
      newDashboardImpl = await ethers.deployContract("Dashboard", [lido, wstETH, vaultHub, locator]);
    });

    it("should allow address with DASHBOARD_IMPL_MANAGER_ROLE to set new dashboard implementation", async () => {
      const oldImpl = await vaultFactory.dashboardImpl();
      const agentSigner = await ctx.getSigner("agent");

      // Agent should already have the DASHBOARD_IMPL_MANAGER_ROLE from deployment
      const tx = await vaultFactory.connect(agentSigner).setDashboardImpl(newDashboardImpl.getAddress());

      await expect(tx)
        .to.emit(vaultFactory, "DashboardImplSet")
        .withArgs(await newDashboardImpl.getAddress());

      expect(await vaultFactory.dashboardImpl()).to.equal(await newDashboardImpl.getAddress());
      expect(await vaultFactory.dashboardImpl()).to.not.equal(oldImpl);
    });

    it("should revert when address without DASHBOARD_IMPL_MANAGER_ROLE tries to set dashboard implementation", async () => {
      const role = await vaultFactory.DASHBOARD_IMPL_MANAGER_ROLE();

      await expect(vaultFactory.connect(defaultAdmin).setDashboardImpl(newDashboardImpl.getAddress()))
        .to.be.revertedWithCustomError(vaultFactory, "AccessControlUnauthorizedAccount")
        .withArgs(defaultAdmin.address, role);

      await expect(vaultFactory.connect(stranger).setDashboardImpl(newDashboardImpl.getAddress()))
        .to.be.revertedWithCustomError(vaultFactory, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, role);
    });

    it("should revert when setting zero address as dashboard implementation", async () => {
      const agentSigner = await ctx.getSigner("agent");

      await expect(vaultFactory.connect(agentSigner).setDashboardImpl(ZeroAddress))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_dashboardImpl");
    });

    it("should revert when setting the same dashboard implementation", async () => {
      const currentImpl = await vaultFactory.dashboardImpl();
      const agentSigner = await ctx.getSigner("agent");

      await expect(vaultFactory.connect(agentSigner).setDashboardImpl(currentImpl)).to.be.revertedWithCustomError(
        vaultFactory,
        "DashboardImplAlreadySet",
      );
    });
  });
});
