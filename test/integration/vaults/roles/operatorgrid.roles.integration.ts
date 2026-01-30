import { expect } from "chai";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, OperatorGrid, VaultHub } from "typechain-types";

import { days, ether, impersonate } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  setupLidoForVaults,
  testMethod,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: OperatorGrid Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agent: HardhatEthersSigner;
  let registryRole: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let roles: HardhatEthersSigner[];

  let operatorGrid: OperatorGrid;
  let vaultHub: VaultHub;
  let vaultAddress: string;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    operatorGrid = ctx.contracts.operatorGrid;
    vaultHub = ctx.contracts.vaultHub;

    // Get DAO agent - it has DEFAULT_ADMIN_ROLE on OperatorGrid
    agent = await ctx.getSigner("agent");

    [registryRole, stranger, vaultOwner, nodeOperator] = await ethers.getSigners();

    // Grant REGISTRY_ROLE from agent
    await operatorGrid.connect(agent).grantRole(await operatorGrid.REGISTRY_ROLE(), registryRole);

    roles = [registryRole, stranger, vaultOwner, nodeOperator];

    // Create a vault for testing
    const { stakingVault, dashboard: dashboardContract } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      vaultOwner,
      nodeOperator,
      nodeOperator,
    );
    vaultAddress = await stakingVault.getAddress();
    dashboard = dashboardContract;
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Role-protected methods", () => {
    before(async () => {
      if (await operatorGrid.hasRole(await operatorGrid.REGISTRY_ROLE(), agent.address)) {
        await operatorGrid.connect(agent).revokeRole(await operatorGrid.REGISTRY_ROLE(), agent.address);
      }
    });

    it("setConfirmExpiry - requires REGISTRY_ROLE", async () => {
      await testMethod(
        operatorGrid,
        "setConfirmExpiry",
        {
          successUsers: [registryRole],
          failingUsers: [...roles.filter((r) => r !== registryRole), agent],
        },
        [days(1n)],
        await operatorGrid.REGISTRY_ROLE(),
      );
    });

    it("registerGroup - requires REGISTRY_ROLE", async () => {
      const [newOperator] = await ethers.getSigners();
      await testMethod(
        operatorGrid,
        "registerGroup",
        {
          successUsers: [registryRole],
          failingUsers: [...roles.filter((r) => r !== registryRole), agent],
        },
        [newOperator.address, ether("1000")],
        await operatorGrid.REGISTRY_ROLE(),
      );
    });

    it("updateGroupShareLimit - requires REGISTRY_ROLE", async () => {
      // First register a group
      const [newOperator] = await ethers.getSigners();
      await operatorGrid.connect(registryRole).registerGroup(newOperator.address, ether("1000"));

      await testMethod(
        operatorGrid,
        "updateGroupShareLimit",
        {
          successUsers: [registryRole],
          failingUsers: [...roles.filter((r) => r !== registryRole), agent],
        },
        [newOperator.address, ether("2000")],
        await operatorGrid.REGISTRY_ROLE(),
      );
    });

    it("registerTiers - requires REGISTRY_ROLE", async () => {
      // First register a group
      const [newOperator] = await ethers.getSigners();
      await operatorGrid.connect(registryRole).registerGroup(newOperator.address, ether("1000"));

      const tierParams = [
        {
          shareLimit: ether("100"),
          reserveRatioBP: 1000n,
          forcedRebalanceThresholdBP: 500n,
          infraFeeBP: 100n,
          liquidityFeeBP: 100n,
          reservationFeeBP: 100n,
        },
      ];

      await testMethod(
        operatorGrid,
        "registerTiers",
        {
          successUsers: [registryRole],
          failingUsers: [...roles.filter((r) => r !== registryRole), agent],
        },
        [newOperator.address, tierParams],
        await operatorGrid.REGISTRY_ROLE(),
      );
    });

    it("alterTiers - requires REGISTRY_ROLE", async () => {
      const tierParams = [
        {
          shareLimit: ether("200"),
          reserveRatioBP: 1500n,
          forcedRebalanceThresholdBP: 600n,
          infraFeeBP: 150n,
          liquidityFeeBP: 150n,
          reservationFeeBP: 150n,
        },
      ];

      await testMethod(
        operatorGrid,
        "alterTiers",
        {
          successUsers: [registryRole],
          failingUsers: [...roles.filter((r) => r !== registryRole), agent],
        },
        [[0n], tierParams],
        await operatorGrid.REGISTRY_ROLE(),
      );
    });

    it("updateVaultFees - requires REGISTRY_ROLE", async () => {
      await testMethod(
        operatorGrid,
        "updateVaultFees",
        {
          successUsers: [registryRole],
          failingUsers: [...roles.filter((r) => r !== registryRole), agent],
        },
        [vaultAddress, 200n, 200n, 200n],
        await operatorGrid.REGISTRY_ROLE(),
      );
    });

    it("setVaultJailStatus - requires REGISTRY_ROLE", async () => {
      await testMethod(
        operatorGrid,
        "setVaultJailStatus",
        {
          successUsers: [registryRole],
          failingUsers: [...roles.filter((r) => r !== registryRole), agent],
        },
        [vaultAddress, true],
        await operatorGrid.REGISTRY_ROLE(),
      );
    });
  });

  describe("Special sender-protected methods", () => {
    it("onMintedShares - requires VaultHub as sender", async () => {
      const method = "onMintedShares";
      const args: [string, bigint, boolean] = [vaultAddress, 100n, false];

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(operatorGrid.connect(user)[method](...args)).to.be.revertedWithCustomError(
          operatorGrid,
          "NotAuthorized",
        );
      }

      // Should succeed for VaultHub
      const vaultHubSigner = await impersonate(await vaultHub.getAddress(), ether("10"));
      await expect(operatorGrid.connect(vaultHubSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("onBurnedShares - requires VaultHub as sender", async () => {
      const method = "onBurnedShares";
      const args: [string, bigint] = [vaultAddress, 100n];

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(operatorGrid.connect(user)[method](...args)).to.be.revertedWithCustomError(
          operatorGrid,
          "NotAuthorized",
        );
      }

      // Should succeed for VaultHub
      const vaultHubSigner = await impersonate(await vaultHub.getAddress(), ether("10"));
      await expect(operatorGrid.connect(vaultHubSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("resetVaultTier - requires VaultHub as sender", async () => {
      const method = "resetVaultTier";
      const args: [string] = [vaultAddress];

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(operatorGrid.connect(user)[method](...args)).to.be.revertedWithCustomError(
          operatorGrid,
          "NotAuthorized",
        );
      }

      // Should succeed for VaultHub
      const vaultHubSigner = await impersonate(await vaultHub.getAddress(), ether("10"));
      await expect(operatorGrid.connect(vaultHubSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });
  });

  describe("Confirmation-based methods", () => {
    it("changeTier - requires vault owner and node operator confirmations", async () => {
      // Setup: register group and tier for nodeOperator to make changeTier reach confirmation check
      await operatorGrid.connect(registryRole).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(registryRole).registerTiers(nodeOperator, [
        {
          shareLimit: ether("1000"),
          reserveRatioBP: 1000n,
          forcedRebalanceThresholdBP: 500n,
          infraFeeBP: 100n,
          liquidityFeeBP: 100n,
          reservationFeeBP: 100n,
        },
      ]);

      const requestedTierId = (await operatorGrid.group(nodeOperator)).tierIds[0];
      const method = "changeTier";
      const args: [string, bigint, bigint] = [vaultAddress, requestedTierId, ether("100")];

      // Should revert with SenderNotMember for unauthorized users (not vault owner or node operator)
      for (const user of [...roles.filter((r) => r !== nodeOperator), agent]) {
        await expect(operatorGrid.connect(user)[method](...args)).to.be.revertedWithCustomError(
          operatorGrid,
          "SenderNotMember",
        );
      }

      // Should not revert with SenderNotMember for vault owner
      // we use dashboard here because it is the vault owner when vault is connected to vault hub
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(operatorGrid.connect(dashboardSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "SenderNotMember",
      );

      // Should not revert with SenderNotMember for node operator
      await expect(operatorGrid.connect(nodeOperator)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "SenderNotMember",
      );
    });

    it("syncTier - requires vault owner and node operator confirmations", async () => {
      // Setup: register group and tier, move vault to tier, then alter tier params to make syncTier reach confirmation check
      await operatorGrid.connect(registryRole).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(registryRole).registerTiers(nodeOperator, [
        {
          shareLimit: ether("1000"),
          reserveRatioBP: 1000n,
          forcedRebalanceThresholdBP: 500n,
          infraFeeBP: 100n,
          liquidityFeeBP: 100n,
          reservationFeeBP: 100n,
        },
      ]);

      const tierId = (await operatorGrid.group(nodeOperator)).tierIds[0];
      const shareLimit = ether("100");

      // Move vault to tier (requires both confirmations)
      await dashboard.connect(vaultOwner).changeTier(tierId, shareLimit);
      await operatorGrid.connect(nodeOperator).changeTier(vaultAddress, tierId, shareLimit);

      // Alter tier params to differ from connection, so syncTier will reach confirmation check
      await operatorGrid.connect(registryRole).alterTiers(
        [tierId],
        [
          {
            shareLimit: ether("1000"),
            reserveRatioBP: 2000n, // Changed from 1000n
            forcedRebalanceThresholdBP: 600n, // Changed from 500n
            infraFeeBP: 150n, // Changed from 100n
            liquidityFeeBP: 150n, // Changed from 100n
            reservationFeeBP: 150n, // Changed from 100n
          },
        ],
      );

      const method = "syncTier";
      const args: [string] = [vaultAddress];

      // Should revert with SenderNotMember for unauthorized users (not vault owner or node operator)
      for (const user of [...roles.filter((r) => r !== nodeOperator), agent]) {
        await expect(operatorGrid.connect(user)[method](...args)).to.be.revertedWithCustomError(
          operatorGrid,
          "SenderNotMember",
        );
      }

      // Should not revert with SenderNotMember for vault owner
      // we use dashboard here because it is the vault owner when vault is connected to vault hub
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(operatorGrid.connect(dashboardSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "SenderNotMember",
      );

      // Should not revert with SenderNotMember for node operator
      await expect(operatorGrid.connect(nodeOperator)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "SenderNotMember",
      );
    });

    it("updateVaultShareLimit - requires vault owner and node operator confirmations", async () => {
      // Setup: register group and tier, move vault to tier to make updateVaultShareLimit reach confirmation check
      await operatorGrid.connect(registryRole).registerGroup(nodeOperator, ether("5000"));
      await operatorGrid.connect(registryRole).registerTiers(nodeOperator, [
        {
          shareLimit: ether("1000"),
          reserveRatioBP: 1000n,
          forcedRebalanceThresholdBP: 500n,
          infraFeeBP: 100n,
          liquidityFeeBP: 100n,
          reservationFeeBP: 100n,
        },
      ]);

      const tierId = (await operatorGrid.group(nodeOperator)).tierIds[0];
      const currentShareLimit = ether("100");
      const newShareLimit = ether("200");

      // Move vault to tier (requires both confirmations)
      await dashboard.connect(vaultOwner).changeTier(tierId, currentShareLimit);
      await operatorGrid.connect(nodeOperator).changeTier(vaultAddress, tierId, currentShareLimit);

      const method = "updateVaultShareLimit";
      const args: [string, bigint] = [vaultAddress, newShareLimit];

      // Should revert with SenderNotMember for unauthorized users (not vault owner or node operator)
      for (const user of [...roles.filter((r) => r !== nodeOperator), agent]) {
        await expect(operatorGrid.connect(user)[method](...args)).to.be.revertedWithCustomError(
          operatorGrid,
          "SenderNotMember",
        );
      }

      // Should not revert with SenderNotMember for vault owner
      // we use dashboard here because it is the vault owner when vault is connected to vault hub
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(operatorGrid.connect(dashboardSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "SenderNotMember",
      );

      // Should not revert with SenderNotMember for node operator
      await expect(operatorGrid.connect(nodeOperator)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "SenderNotMember",
      );
    });
  });
});
