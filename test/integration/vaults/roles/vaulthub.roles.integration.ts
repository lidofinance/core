import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { days, ether, impersonate, PDGPolicy } from "lib";
import {
  autofillRoles,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  setupLidoForVaults,
  testMethod,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agent: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let vaultMaster: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;
  let validatorExitRole: HardhatEthersSigner;
  let badDebtMaster: HardhatEthersSigner;
  let pauseRole: HardhatEthersSigner;
  let resumeRole: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let roles: HardhatEthersSigner[];

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let vaultAddress: string;
  let dashboard: Dashboard;
  let dashboardRoles: VaultRoles;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    vaultHub = ctx.contracts.vaultHub;

    // Get DAO agent - it has DEFAULT_ADMIN_ROLE on VaultHub
    agent = await ctx.getSigner("agent");

    [
      owner,
      nodeOperatorManager,
      vaultMaster,
      redemptionMaster,
      validatorExitRole,
      badDebtMaster,
      pauseRole,
      resumeRole,
      stranger,
    ] = await ethers.getSigners();

    // Grant roles from agent (DEFAULT_ADMIN)
    await vaultHub.connect(agent).grantRole(await vaultHub.VAULT_MASTER_ROLE(), vaultMaster);
    await vaultHub.connect(agent).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    await vaultHub.connect(agent).grantRole(await vaultHub.VALIDATOR_EXIT_ROLE(), validatorExitRole);
    await vaultHub.connect(agent).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), badDebtMaster);
    await vaultHub.connect(agent).grantRole(await vaultHub.PAUSE_ROLE(), pauseRole);
    await vaultHub.connect(agent).grantRole(await vaultHub.RESUME_ROLE(), resumeRole);

    roles = [
      owner,
      nodeOperatorManager,
      vaultMaster,
      redemptionMaster,
      validatorExitRole,
      badDebtMaster,
      pauseRole,
      resumeRole,
      stranger,
    ];

    // Create a vault for testing (owner will be the admin of Dashboard)
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperatorManager,
      nodeOperatorManager,
    ));

    vaultAddress = await stakingVault.getAddress();

    // Grant roles on Dashboard
    dashboardRoles = await autofillRoles(dashboard, nodeOperatorManager);

    // Fund the vault via Dashboard (owner has admin role on Dashboard)
    await dashboard.connect(owner).fund({ value: ether("10") });
    await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Role-protected methods", () => {
    it("pauseFor - requires PAUSE_ROLE", async () => {
      await testMethod(
        vaultHub,
        "pauseFor",
        {
          successUsers: [pauseRole],
          failingUsers: [...roles.filter((r) => r !== pauseRole), agent],
        },
        [days(1n)],
        await vaultHub.PAUSE_ROLE(),
      );
    });

    it("pauseUntil - requires PAUSE_ROLE", async () => {
      const futureTimestamp = BigInt(Math.floor(Date.now() / 1000) + 86400);
      await testMethod(
        vaultHub,
        "pauseUntil",
        {
          successUsers: [pauseRole],
          failingUsers: [...roles.filter((r) => r !== pauseRole), agent],
        },
        [futureTimestamp],
        await vaultHub.PAUSE_ROLE(),
      );
    });

    it("resume - requires RESUME_ROLE", async () => {
      // First pause the contract
      await vaultHub.connect(pauseRole).pauseFor(days(1n));

      await testMethod(
        vaultHub,
        "resume",
        {
          successUsers: [resumeRole],
          failingUsers: [...roles.filter((r) => r !== resumeRole), agent],
        },
        [],
        await vaultHub.RESUME_ROLE(),
      );
    });

    it("setLiabilitySharesTarget - requires REDEMPTION_MASTER_ROLE", async () => {
      // This role is granted to agent on Hoodi testnet
      if (await vaultHub.hasRole(await vaultHub.REDEMPTION_MASTER_ROLE(), agent.address)) {
        await vaultHub.connect(agent).revokeRole(await vaultHub.REDEMPTION_MASTER_ROLE(), agent.address);
      }
      await testMethod(
        vaultHub,
        "setLiabilitySharesTarget",
        {
          successUsers: [redemptionMaster],
          failingUsers: [...roles.filter((r) => r !== redemptionMaster), agent],
        },
        [vaultAddress, 0n],
        await vaultHub.REDEMPTION_MASTER_ROLE(),
      );
    });

    it("disconnect - requires VAULT_MASTER_ROLE", async () => {
      // This role is granted to agent on Hoodi testnet
      if (await vaultHub.hasRole(await vaultHub.VAULT_MASTER_ROLE(), agent.address)) {
        await vaultHub.connect(agent).revokeRole(await vaultHub.VAULT_MASTER_ROLE(), agent.address);
      }
      await testMethod(
        vaultHub,
        "disconnect",
        {
          successUsers: [vaultMaster],
          failingUsers: [...roles.filter((r) => r !== vaultMaster), agent],
        },
        [vaultAddress],
        await vaultHub.VAULT_MASTER_ROLE(),
      );
    });

    it("socializeBadDebt - requires BAD_DEBT_MASTER_ROLE", async () => {
      // Create another vault for bad debt socialization (same node operator)
      const [anotherVaultAdmin] = await ethers.getSigners();
      const { stakingVault: vault2 } = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        anotherVaultAdmin,
        stranger, // same node operator as first vault
        stranger,
      );
      const vault2Address = await vault2.getAddress();

      await testMethod(
        vaultHub,
        "socializeBadDebt",
        {
          successUsers: [badDebtMaster],
          failingUsers: [...roles.filter((r) => r !== badDebtMaster), agent],
        },
        [vaultAddress, vault2Address, 1n],
        await vaultHub.BAD_DEBT_MASTER_ROLE(),
      );
    });

    it("internalizeBadDebt - requires BAD_DEBT_MASTER_ROLE", async () => {
      await testMethod(
        vaultHub,
        "internalizeBadDebt",
        {
          successUsers: [badDebtMaster],
          failingUsers: [...roles.filter((r) => r !== badDebtMaster), agent],
        },
        [vaultAddress, 1n],
        await vaultHub.BAD_DEBT_MASTER_ROLE(),
      );
    });

    it("forceValidatorExit - requires VALIDATOR_EXIT_ROLE", async () => {
      await testMethod(
        vaultHub,
        "forceValidatorExit",
        {
          successUsers: [validatorExitRole],
          failingUsers: [...roles.filter((r) => r !== validatorExitRole), agent],
        },
        [vaultAddress, "0x", stranger.address],
        await vaultHub.VALIDATOR_EXIT_ROLE(),
      );
    });
  });

  describe("Special sender-protected methods", () => {
    it("updateConnection - requires OperatorGrid as sender", async () => {
      const method = "updateConnection";
      const args: [string, bigint, bigint, bigint, bigint, bigint, bigint] = [
        vaultAddress,
        100n,
        100n,
        100n,
        100n,
        100n,
        100n,
      ];

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user)[method](...args)).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for OperatorGrid (but might fail for other reasons)
      const operatorGridSigner = await impersonate(await ctx.contracts.operatorGrid.getAddress(), ether("10"));
      await expect(vaultHub.connect(operatorGridSigner)[method](...args)).to.not.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("applyVaultReport - requires LazyOracle as sender", async () => {
      const method = "applyVaultReport";
      const args: [string, bigint, bigint, bigint, bigint, bigint, bigint, bigint] = [
        vaultAddress,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
      ];

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user)[method](...args)).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for LazyOracle (but might fail for other reasons)
      const lazyOracleSigner = await impersonate(await ctx.contracts.lazyOracle.getAddress(), ether("10"));
      await expect(vaultHub.connect(lazyOracleSigner)[method](...args)).to.not.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("decreaseInternalizedBadDebt - requires Accounting as sender", async () => {
      const method = "decreaseInternalizedBadDebt";
      const args: [bigint] = [1n];

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user)[method](...args)).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for Accounting contract (but might fail for other reasons)
      const accountingSigner = await impersonate(await ctx.contracts.accounting.getAddress(), ether("10"));
      await expect(vaultHub.connect(accountingSigner)[method](...args)).to.not.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });
  });

  describe("Owner-only methods (owner is Dashboard contract)", () => {
    // Note: VaultConnection.owner is the Dashboard contract address, not an EOA.
    // These methods are designed to be called by the Dashboard contract, not directly by users.

    it("connectVault - requires vault owner (Dashboard)", async () => {
      // Create a new vault without connecting to VaultHub using special factory method
      const [newVaultAdmin, newNodeOperator] = await ethers.getSigners();

      const tx = await ctx.contracts.stakingVaultFactory
        .connect(newVaultAdmin)
        .createVaultWithDashboardWithoutConnectingToVaultHub(
          newVaultAdmin.address,
          newNodeOperator.address,
          newVaultAdmin.address,
          500n, // fee
          7n * 24n * 60n * 60n, // confirm expiry - 7 days
          [], // no role assignments
        );

      const receipt = await tx.wait();
      const newVaultAddress = ctx.getEvents(receipt!, "VaultCreated")[0].args!.vault;
      const newDashboardAddress = ctx.getEvents(receipt!, "DashboardCreated")[0].args!.dashboard;

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user).connectVault(newVaultAddress)).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }

      // Dashboard (vault owner) can call it - won't get NotAuthorized
      const newDashboardSigner = await impersonate(newDashboardAddress, ether("10"));
      await expect(
        vaultHub.connect(newDashboardSigner).connectVault(newVaultAddress),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("transferAndBurnShares - requires vault owner (Dashboard)", async () => {
      // This method first does transferSharesFrom, then calls burnShares which checks owner
      // Need to give both stranger and dashboard shares and approval to pass the transfer check
      const sharesAmount = 100n;

      // Should fail for unauthorized callers (ACL check in burnShares)
      for (const user of [...roles, agent]) {
        // Prepare shares and approval for stranger
        await dashboard.connect(dashboardRoles.minter).mintShares(user, sharesAmount);
        await ctx.contracts.lido.connect(user).approve(vaultHub, sharesAmount);
        await expect(vaultHub.connect(user).transferAndBurnShares(vaultAddress, 1n)).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }

      // Prepare shares and approval for Dashboard
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await dashboard.connect(dashboardRoles.minter).mintShares(await dashboard.getAddress(), sharesAmount);
      await ctx.contracts.lido.connect(dashboardSigner).approve(vaultHub, sharesAmount);

      // Should succeed for Dashboard (owner in VaultHub)
      await expect(
        vaultHub.connect(dashboardSigner).transferAndBurnShares(vaultAddress, 1n),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("fund - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user).fund(vaultAddress, { value: ether("1") })).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }
      // Should succeed for Dashboard (owner in VaultHub)
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).fund(vaultAddress, { value: ether("1") }),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("withdraw - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(
          vaultHub.connect(user).withdraw(vaultAddress, stranger.address, ether("1")),
        ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).withdraw(vaultAddress, stranger.address, ether("1")),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("mintShares - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(
          vaultHub.connect(user).mintShares(vaultAddress, stranger.address, 100n),
        ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).mintShares(vaultAddress, stranger.address, 100n),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("burnShares - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user).burnShares(vaultAddress, 1n)).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(vaultHub.connect(dashboardSigner).burnShares(vaultAddress, 1n)).to.not.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("voluntaryDisconnect - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).voluntaryDisconnect(vaultAddress),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("transferVaultOwnership - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(
          vaultHub.connect(user).transferVaultOwnership(vaultAddress, stranger.address),
        ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for Dashboard (owner in VaultHub)
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).transferVaultOwnership(vaultAddress, stranger.address),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("pauseBeaconChainDeposits - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user).pauseBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }

      // Should succeed for Dashboard (owner in VaultHub)
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).pauseBeaconChainDeposits(vaultAddress),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("resumeBeaconChainDeposits - requires vault owner (Dashboard)", async () => {
      // First pause deposits as Dashboard
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await vaultHub.connect(dashboardSigner).pauseBeaconChainDeposits(vaultAddress);

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user).resumeBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      await expect(
        vaultHub.connect(dashboardSigner).resumeBeaconChainDeposits(vaultAddress),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("requestValidatorExit - requires vault owner (Dashboard)", async () => {
      const pubkeys = "0x" + "ab".repeat(48);

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user).requestValidatorExit(vaultAddress, pubkeys)).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }

      // Should succeed for Dashboard (owner in VaultHub)
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).requestValidatorExit(vaultAddress, pubkeys),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("triggerValidatorWithdrawals - requires vault owner (Dashboard)", async () => {
      const pubkeys = "0x";
      const amounts: bigint[] = [];

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(
          vaultHub.connect(user).triggerValidatorWithdrawals(vaultAddress, pubkeys, amounts, stranger.address),
        ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).triggerValidatorWithdrawals(vaultAddress, pubkeys, amounts, stranger.address),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("rebalance - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(vaultHub.connect(user).rebalance(vaultAddress, 1n)).to.be.revertedWithCustomError(
          vaultHub,
          "NotAuthorized",
        );
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(vaultHub.connect(dashboardSigner).rebalance(vaultAddress, 1n)).to.not.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("proveUnknownValidatorToPDG - requires vault owner (Dashboard)", async () => {
      const witness = {
        proof: ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
        pubkey: "0x",
        validatorIndex: 0n,
        childBlockTimestamp: 0n,
        slot: 0n,
        proposerIndex: 0n,
      };

      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(
          vaultHub.connect(user).proveUnknownValidatorToPDG(vaultAddress, witness),
        ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).proveUnknownValidatorToPDG(vaultAddress, witness),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("collectERC20FromVault - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      for (const user of [...roles, agent]) {
        await expect(
          vaultHub.connect(user).collectERC20FromVault(vaultAddress, ZeroAddress, stranger.address, 1n),
        ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
      }

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).collectERC20FromVault(vaultAddress, ZeroAddress, stranger.address, 1n),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });
  });
});
