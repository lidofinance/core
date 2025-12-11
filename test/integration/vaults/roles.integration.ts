import { expect } from "chai";
import { ContractMethodArgs, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, LazyOracle, OperatorGrid, StakingVault, VaultHub } from "typechain-types";

import { days, ether, impersonate, PDGPolicy, randomValidatorPubkey } from "lib";
import {
  autofillRoles,
  createVaultWithDashboard,
  getProtocolContext,
  getRoleMethods,
  ProtocolContext,
  setupLidoForVaults,
  VaultRoles,
} from "lib/protocol";
import { vaultRoleKeys } from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

type Methods<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]: T[K] extends (...args: any) => any ? K : never;
}[keyof T];

type DashboardMethods = Methods<Dashboard>; // "foo" | "bar"

describe("Integration: Staking Vaults Dashboard Roles Initial Setup", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let dashboard: Dashboard;
  let roles: VaultRoles;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    [owner, nodeOperatorManager, stranger] = await ethers.getSigners();

    ({ dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperatorManager,
      nodeOperatorManager,
    ));

    await dashboard.connect(owner).fund({ value: ether("1") });
    await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  // initializing contracts without signers
  describe("No roles are assigned", () => {
    it("Verify that roles are not assigned", async () => {
      const roleMethods = getRoleMethods(dashboard);

      for (const role of vaultRoleKeys) {
        expect(await dashboard.getRoleMembers(await roleMethods[role])).to.deep.equal([], `Role "${role}" is assigned`);
      }
    });

    describe("Verify ACL for methods that require only role", () => {
      describe("Dashboard methods", () => {
        it("setNodeOperatorFeeRecipient", async () => {
          await testGrantingRole(
            "setFeeRecipient",
            await dashboard.NODE_OPERATOR_MANAGER_ROLE(),
            [stranger],
            nodeOperatorManager,
          );
        });
      });
    });
  });

  // initializing contracts with signers
  describe("All the roles are assigned", () => {
    before(async () => {
      roles = await autofillRoles(dashboard, nodeOperatorManager);
    });

    it("Allows anyone to read public metrics of the vault", async () => {
      expect(await dashboard.connect(stranger).accruedFee()).to.equal(0);
      expect(await dashboard.connect(stranger).withdrawableValue()).to.equal(ether("1"));
    });

    it("Allows to retrieve roles addresses", async () => {
      expect(await dashboard.getRoleMembers(await dashboard.MINT_ROLE())).to.deep.equal([roles.minter.address]);
    });

    it("Allows NO Manager to add and remove new managers", async () => {
      await dashboard.connect(nodeOperatorManager).grantRole(await dashboard.NODE_OPERATOR_MANAGER_ROLE(), stranger);
      expect(await dashboard.getRoleMembers(await dashboard.NODE_OPERATOR_MANAGER_ROLE())).to.deep.equal([
        nodeOperatorManager.address,
        stranger.address,
      ]);
      await dashboard.connect(nodeOperatorManager).revokeRole(await dashboard.NODE_OPERATOR_MANAGER_ROLE(), stranger);
      expect(await dashboard.getRoleMembers(await dashboard.NODE_OPERATOR_MANAGER_ROLE())).to.deep.equal([
        nodeOperatorManager.address,
      ]);
    });

    describe("Verify ACL for methods that require only role", () => {
      describe("Dashboard methods", () => {
        it("recoverERC20", async () => {
          await testMethod(
            "recoverERC20",
            {
              successUsers: [owner],
              failingUsers: [...Object.values(roles), nodeOperatorManager, stranger],
            },
            [ZeroAddress, owner, 1n],
            await dashboard.DEFAULT_ADMIN_ROLE(),
          );
        });

        it("collectERC20FromVault", async () => {
          await testMethod(
            "collectERC20FromVault",
            {
              successUsers: [roles.assetCollector, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.assetCollector),
                nodeOperatorManager,
                stranger,
              ],
            },
            [ZeroAddress, owner, 1n],
            await dashboard.COLLECT_VAULT_ERC20_ROLE(),
          );
        });

        it("triggerValidatorWithdrawal", async () => {
          await testMethod(
            "triggerValidatorWithdrawals",
            {
              successUsers: [roles.validatorWithdrawalTriggerer, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.validatorWithdrawalTriggerer),
                nodeOperatorManager,
                stranger,
              ],
            },
            ["0x", [0n], stranger],
            await dashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
          );
        });

        it("requestValidatorExit", async () => {
          await testMethod(
            "requestValidatorExit",
            {
              successUsers: [roles.validatorExitRequester, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.validatorExitRequester),
                nodeOperatorManager,
                stranger,
              ],
            },
            ["0x" + "ab".repeat(48)],
            await dashboard.REQUEST_VALIDATOR_EXIT_ROLE(),
          );
        });

        it("resumeBeaconChainDeposits", async () => {
          await testMethod(
            "resumeBeaconChainDeposits",
            {
              successUsers: [roles.depositResumer, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.depositResumer),
                nodeOperatorManager,
                stranger,
              ],
            },
            [],
            await dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
          );
        });

        it("pauseBeaconChainDeposits", async () => {
          await testMethod(
            "pauseBeaconChainDeposits",
            {
              successUsers: [roles.depositPauser, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.depositPauser),
                nodeOperatorManager,
                stranger,
              ],
            },
            [],
            await dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
          );
        });

        it("unguaranteedDepositToBeaconChain", async () => {
          await testMethod(
            "unguaranteedDepositToBeaconChain",
            {
              successUsers: [roles.unguaranteedDepositor, nodeOperatorManager],
              failingUsers: Object.values(roles).filter(
                (r) => r !== roles.unguaranteedDepositor && r !== nodeOperatorManager,
              ),
            },
            [
              [
                {
                  pubkey: randomValidatorPubkey(),
                  amount: ether("1"),
                  signature: new Uint8Array(32),
                  depositDataRoot: new Uint8Array(32),
                },
              ],
            ],
            await dashboard.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE(),
          );
        });

        it("proveUnknownValidatorsToPDG", async () => {
          await testMethod(
            "proveUnknownValidatorsToPDG",
            {
              successUsers: [roles.unknownValidatorProver, nodeOperatorManager],
              failingUsers: Object.values(roles).filter(
                (r) => r !== roles.unknownValidatorProver && r !== nodeOperatorManager,
              ),
            },
            [
              [
                {
                  proof: ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
                  pubkey: "0x",
                  validatorIndex: 0n,
                  childBlockTimestamp: 0n,
                  slot: 0n,
                  proposerIndex: 0n,
                },
              ],
            ],
            await dashboard.NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it("addFeeExemption", async () => {
          await testMethod(
            "addFeeExemption",
            {
              successUsers: [roles.nodeOperatorFeeExemptor, nodeOperatorManager],
              failingUsers: Object.values(roles).filter(
                (r) => r !== roles.nodeOperatorFeeExemptor && r !== nodeOperatorManager,
              ),
            },
            [100n],
            await dashboard.NODE_OPERATOR_FEE_EXEMPT_ROLE(),
          );
        });

        it("rebalanceVaultWithShares", async () => {
          await testMethod(
            "rebalanceVaultWithShares",
            {
              successUsers: [roles.rebalancer, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.rebalancer),
                nodeOperatorManager,
                stranger,
              ],
            },
            [1n],
            await dashboard.REBALANCE_ROLE(),
          );
        });

        it("rebalanceVaultWithEther", async () => {
          await testMethod(
            "rebalanceVaultWithEther",
            {
              successUsers: [roles.rebalancer, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.rebalancer),
                nodeOperatorManager,
                stranger,
              ],
            },
            [1n],
            await dashboard.REBALANCE_ROLE(),
          );
        });

        it("mintWstETH", async () => {
          await testMethod(
            "mintWstETH",
            {
              successUsers: [roles.minter, owner],
              failingUsers: [...Object.values(roles).filter((r) => r !== roles.minter), nodeOperatorManager, stranger],
            },
            [ZeroAddress, 0, stranger],
            await dashboard.MINT_ROLE(),
          );
        });

        it("mintStETH", async () => {
          await testMethod(
            "mintStETH",
            {
              successUsers: [roles.minter, owner],
              failingUsers: [...Object.values(roles).filter((r) => r !== roles.minter), nodeOperatorManager, stranger],
            },
            [stranger, 1n],
            await dashboard.MINT_ROLE(),
          );
        });

        it("mintShares", async () => {
          await testMethod(
            "mintShares",
            {
              successUsers: [roles.minter, owner],
              failingUsers: [...Object.values(roles).filter((r) => r !== roles.minter), nodeOperatorManager, stranger],
            },
            [stranger, 100n],
            await dashboard.MINT_ROLE(),
          );
        });

        it("burnShares", async () => {
          // Mint shares to all users - balance check happens before ACL check
          const sharesAmount = 100n;
          const allUsers = [...Object.values(roles), owner, nodeOperatorManager, stranger];
          await dashboard.connect(roles.minter).mintShares(roles.minter, sharesAmount * BigInt(2 * allUsers.length));
          const stethAmount = await ctx.contracts.lido.getPooledEthByShares(sharesAmount);
          for (const user of allUsers) {
            await ctx.contracts.lido.connect(roles.minter).transferShares(user, stethAmount);
            await ctx.contracts.lido.connect(user).approve(dashboard, stethAmount);
          }

          await testMethod(
            "burnShares",
            {
              successUsers: [roles.burner, owner],
              failingUsers: [...Object.values(roles).filter((r) => r !== roles.burner), nodeOperatorManager, stranger],
            },
            [1n],
            await dashboard.BURN_ROLE(),
          );
        });

        it("burnStETH", async () => {
          await testMethod(
            "burnStETH",
            {
              successUsers: [roles.burner, owner],
              failingUsers: [...Object.values(roles).filter((r) => r !== roles.burner), nodeOperatorManager, stranger],
            },
            [1n],
            await dashboard.BURN_ROLE(),
          );
        });

        it("burnWstETH", async () => {
          // Mint shares and wrap to wstETH for all users - balance check happens before ACL check
          const sharesAmount = 100n;
          const allUsers = [...Object.values(roles), owner, nodeOperatorManager, stranger];
          // Mint stETH shares via dashboard
          const totalSharesToMint = sharesAmount * BigInt(allUsers.length);
          await dashboard.connect(roles.minter).mintShares(roles.minter, totalSharesToMint);
          const stethAmount = await ctx.contracts.lido.getPooledEthByShares(totalSharesToMint);
          // Wrap to wstETH
          await ctx.contracts.lido.connect(roles.minter).approve(ctx.contracts.wstETH, stethAmount);
          await ctx.contracts.wstETH.connect(roles.minter).wrap(stethAmount);
          const wstethBalance = await ctx.contracts.wstETH.balanceOf(roles.minter);
          const wstethAmountToTransfer = wstethBalance / BigInt(allUsers.length + 1);
          for (const user of allUsers) {
            await ctx.contracts.wstETH.connect(roles.minter).transfer(user, wstethAmountToTransfer);
            await ctx.contracts.wstETH.connect(user).approve(dashboard, wstethAmountToTransfer);
          }

          await testMethod(
            "burnWstETH",
            {
              successUsers: [roles.burner, owner],
              failingUsers: [...Object.values(roles).filter((r) => r !== roles.burner), nodeOperatorManager, stranger],
            },
            [1n],
            await dashboard.BURN_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        // fund 2 ether, cause vault has 1 ether locked already
        it("withdraw", async () => {
          await dashboard.connect(roles.funder).fund({ value: ether("2") });
          await testMethod(
            "withdraw",
            {
              successUsers: [roles.withdrawer, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.withdrawer),
                nodeOperatorManager,
                stranger,
              ],
            },
            [stranger, ether("1")],
            await dashboard.WITHDRAW_ROLE(),
          );
        });

        it("fund", async () => {
          await testMethod(
            "fund",
            {
              successUsers: [roles.funder, owner],
              failingUsers: [...Object.values(roles).filter((r) => r !== roles.funder), nodeOperatorManager, stranger],
            },
            [{ value: 1n }],
            await dashboard.FUND_ROLE(),
          );
        });

        it("voluntaryDisconnect", async () => {
          await testMethod(
            "voluntaryDisconnect",
            {
              successUsers: [roles.disconnecter, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.disconnecter),
                nodeOperatorManager,
                stranger,
              ],
            },
            [],
            await dashboard.VOLUNTARY_DISCONNECT_ROLE(),
          );
        });

        it("requestTierChange", async () => {
          await testMethod(
            "changeTier",
            {
              successUsers: [roles.tierChanger, owner],
              failingUsers: [
                ...Object.values(roles).filter((r) => r !== roles.tierChanger),
                nodeOperatorManager,
                stranger,
              ],
            },
            [1n, 1n],
            await dashboard.VAULT_CONFIGURATION_ROLE(),
          );
        });

        it("setPDGPolicy", async () => {
          await testMethod(
            "setPDGPolicy",
            {
              successUsers: [owner],
              failingUsers: [...Object.values(roles), nodeOperatorManager, stranger],
            },
            [PDGPolicy.STRICT],
            await dashboard.DEFAULT_ADMIN_ROLE(),
          );
        });

        it("disburseAbnormallyHighFee", async () => {
          await testMethod(
            "disburseAbnormallyHighFee",
            {
              successUsers: [owner],
              failingUsers: [...Object.values(roles), nodeOperatorManager, stranger],
            },
            [],
            await dashboard.DEFAULT_ADMIN_ROLE(),
          );
        });

        describe("renounceRole()", () => {
          for (const role of vaultRoleKeys) {
            it(`reverts if called for role ${role}`, async function () {
              const roleMethods = getRoleMethods(dashboard);
              const roleId = await roleMethods[role];
              const caller = roles[role];
              await expect(dashboard.connect(caller).renounceRole(roleId, caller)).to.be.revertedWithCustomError(
                dashboard,
                "RoleRenouncementDisabled",
              );
            });
          }
        });
      });
    });

    describe("Verify ACL for methods that require confirmations", () => {
      it("setNodeOperatorFeeBP", async () => {
        await expect(dashboard.connect(owner).setFeeRate(1n)).not.to.emit(dashboard, "FeeRateSet");
        await expect(dashboard.connect(nodeOperatorManager).setFeeRate(1n)).to.emit(dashboard, "FeeRateSet");

        await testMethodConfirmedRoles(
          "setFeeRate",
          {
            successUsers: [owner, nodeOperatorManager],
            failingUsers: [...Object.values(roles), stranger],
          },
          [1n],
        );
      });

      it("setConfirmExpiry", async () => {
        await expect(dashboard.connect(owner).setConfirmExpiry(days(7n))).not.to.emit(dashboard, "ConfirmExpirySet");
        await expect(dashboard.connect(nodeOperatorManager).setConfirmExpiry(days(7n))).to.emit(
          dashboard,
          "ConfirmExpirySet",
        );

        await testMethodConfirmedRoles(
          "setConfirmExpiry",
          {
            successUsers: [owner, nodeOperatorManager],
            failingUsers: [...Object.values(roles), stranger],
          },
          [days(7n)],
        );
      });

      it("transferVaultOwnership confirmations", async () => {
        await testMethodConfirmedRoles(
          "transferVaultOwnership",
          {
            successUsers: [owner, nodeOperatorManager],
            failingUsers: Object.values(roles),
          },
          [stranger.address],
        );
      });

      it("correctSettledGrowth confirmations", async () => {
        await testMethodConfirmedRoles(
          "correctSettledGrowth",
          {
            successUsers: [owner, nodeOperatorManager],
            failingUsers: Object.values(roles),
          },
          [0n, 0n],
        );
      });
    });

    it("Allows anyone to read public metrics of the vault", async () => {
      expect(await dashboard.connect(stranger).accruedFee()).to.equal(0);
      expect(await dashboard.connect(stranger).withdrawableValue()).to.equal(ether("1"));
    });

    it("Allows to retrieve roles addresses", async () => {
      expect(await dashboard.getRoleMembers(await dashboard.MINT_ROLE())).to.deep.equal([roles.minter.address]);
    });
  });

  async function testMethod<T extends unknown[]>(
    methodName: DashboardMethods,
    { successUsers, failingUsers }: { successUsers: HardhatEthersSigner[]; failingUsers: HardhatEthersSigner[] },
    argument: T,
    requiredRole: string,
  ) {
    for (const user of failingUsers) {
      await expect(dashboard.connect(user)[methodName](...(argument as ContractMethodArgs<T>)))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(user, requiredRole);
    }

    for (const user of successUsers) {
      await expect(
        dashboard.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.not.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    }
  }

  async function testMethodConfirmedRoles<T extends unknown[]>(
    methodName: DashboardMethods,
    { successUsers, failingUsers }: { successUsers: HardhatEthersSigner[]; failingUsers: HardhatEthersSigner[] },
    argument: T,
  ) {
    for (const user of failingUsers) {
      await expect(
        dashboard.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.revertedWithCustomError(dashboard, "SenderNotMember");
    }

    for (const user of successUsers) {
      await expect(
        dashboard.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.not.revertedWithCustomError(dashboard, "SenderNotMember");
    }
  }

  async function testGrantingRole<T extends unknown[]>(
    methodName: DashboardMethods,
    roleToGrant: string,
    argument: T,
    roleGratingActor: HardhatEthersSigner,
  ) {
    await expect(
      dashboard.connect(stranger)[methodName](...(argument as ContractMethodArgs<T>)),
    ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");

    await dashboard.connect(roleGratingActor).grantRole(roleToGrant, stranger);

    await expect(
      dashboard.connect(stranger)[methodName](...(argument as ContractMethodArgs<T>)),
    ).to.not.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");

    await dashboard.connect(roleGratingActor).revokeRole(roleToGrant, stranger);
  }
});

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
  let stranger: HardhatEthersSigner;

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

    [owner, nodeOperatorManager, vaultMaster, redemptionMaster, validatorExitRole, badDebtMaster, stranger] =
      await ethers.getSigners();

    // Grant roles from agent (DEFAULT_ADMIN)
    await vaultHub.connect(agent).grantRole(await vaultHub.VAULT_MASTER_ROLE(), vaultMaster);
    await vaultHub.connect(agent).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    await vaultHub.connect(agent).grantRole(await vaultHub.VALIDATOR_EXIT_ROLE(), validatorExitRole);
    await vaultHub.connect(agent).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), badDebtMaster);

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
    it("setLiabilitySharesTarget - requires REDEMPTION_MASTER_ROLE", async () => {
      const method = "setLiabilitySharesTarget";
      const args: [string, bigint] = [vaultAddress, 0n];

      // Should fail for non-role holders
      await expect(vaultHub.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.REDEMPTION_MASTER_ROLE());

      // Should succeed for role holder
      await expect(vaultHub.connect(redemptionMaster)[method](...args)).to.not.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("disconnect - requires VAULT_MASTER_ROLE", async () => {
      const method = "disconnect";
      const args: [string] = [vaultAddress];

      // Should fail for non-role holders
      await expect(vaultHub.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.VAULT_MASTER_ROLE());

      // Should succeed for role holder (but might fail for other reasons - we only check ACL)
      await expect(vaultHub.connect(vaultMaster)[method](...args)).to.not.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
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

      const method = "socializeBadDebt";
      const args: [string, string, bigint] = [vaultAddress, vault2Address, 1n];

      // Should fail for non-role holders
      await expect(vaultHub.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.BAD_DEBT_MASTER_ROLE());

      // Should succeed for role holder (but might fail for other reasons - we only check ACL)
      await expect(vaultHub.connect(badDebtMaster)[method](...args)).to.not.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("internalizeBadDebt - requires BAD_DEBT_MASTER_ROLE", async () => {
      const method = "internalizeBadDebt";
      const args: [string, bigint] = [vaultAddress, 1n];

      // Should fail for non-role holders
      await expect(vaultHub.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.BAD_DEBT_MASTER_ROLE());

      // Should succeed for role holder (but might fail for other reasons - we only check ACL)
      await expect(vaultHub.connect(badDebtMaster)[method](...args)).to.not.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("forceValidatorExit - requires VALIDATOR_EXIT_ROLE", async () => {
      const method = "forceValidatorExit";
      const args: [string, string, string] = [vaultAddress, "0x", stranger.address];

      // Should fail for non-role holders
      await expect(vaultHub.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.VALIDATOR_EXIT_ROLE());

      // Should succeed for role holder (but might fail for other reasons - we only check ACL)
      await expect(vaultHub.connect(validatorExitRole)[method](...args)).to.not.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
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
      await expect(vaultHub.connect(stranger)[method](...args)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

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
      await expect(vaultHub.connect(stranger)[method](...args)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

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
      await expect(vaultHub.connect(stranger)[method](...args)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

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

      // Should fail for unauthorized callers (stranger is not the vault owner)
      await expect(vaultHub.connect(stranger).connectVault(newVaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

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

      // Prepare shares and approval for stranger
      await dashboard.connect(dashboardRoles.minter).mintShares(stranger, sharesAmount);
      await ctx.contracts.lido.connect(stranger).approve(vaultHub, sharesAmount);

      // Should fail for unauthorized callers (ACL check in burnShares)
      await expect(vaultHub.connect(stranger).transferAndBurnShares(vaultAddress, 1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

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
      await expect(vaultHub.connect(stranger).fund(vaultAddress, { value: ether("1") })).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

      // Should succeed for Dashboard (owner in VaultHub)
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).fund(vaultAddress, { value: ether("1") }),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("withdraw - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      await expect(
        vaultHub.connect(stranger).withdraw(vaultAddress, stranger.address, ether("1")),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).withdraw(vaultAddress, stranger.address, ether("1")),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("mintShares - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      await expect(
        vaultHub.connect(stranger).mintShares(vaultAddress, stranger.address, 100n),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).mintShares(vaultAddress, stranger.address, 100n),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("burnShares - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      await expect(vaultHub.connect(stranger).burnShares(vaultAddress, 1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(vaultHub.connect(dashboardSigner).burnShares(vaultAddress, 1n)).to.not.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("voluntaryDisconnect - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      await expect(vaultHub.connect(stranger).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).voluntaryDisconnect(vaultAddress),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("transferVaultOwnership - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      await expect(
        vaultHub.connect(stranger).transferVaultOwnership(vaultAddress, stranger.address),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");

      // Should succeed for Dashboard (owner in VaultHub)
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).transferVaultOwnership(vaultAddress, stranger.address),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("pauseBeaconChainDeposits - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      await expect(vaultHub.connect(stranger).pauseBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

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
      await expect(vaultHub.connect(stranger).resumeBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      await expect(
        vaultHub.connect(dashboardSigner).resumeBeaconChainDeposits(vaultAddress),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("requestValidatorExit - requires vault owner (Dashboard)", async () => {
      const pubkeys = "0x" + "ab".repeat(48);

      // Should fail for unauthorized callers
      await expect(
        vaultHub.connect(stranger).requestValidatorExit(vaultAddress, pubkeys),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");

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
      await expect(
        vaultHub.connect(stranger).triggerValidatorWithdrawals(vaultAddress, pubkeys, amounts, stranger.address),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).triggerValidatorWithdrawals(vaultAddress, pubkeys, amounts, stranger.address),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("rebalance - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      await expect(vaultHub.connect(stranger).rebalance(vaultAddress, 1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );

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
      await expect(
        vaultHub.connect(stranger).proveUnknownValidatorToPDG(vaultAddress, witness),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).proveUnknownValidatorToPDG(vaultAddress, witness),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("collectERC20FromVault - requires vault owner (Dashboard)", async () => {
      // Should fail for unauthorized callers
      await expect(
        vaultHub.connect(stranger).collectERC20FromVault(vaultAddress, ZeroAddress, stranger.address, 1n),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");

      // Should succeed for Dashboard (owner in VaultHub) - but might fail for other reasons
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(
        vaultHub.connect(dashboardSigner).collectERC20FromVault(vaultAddress, ZeroAddress, stranger.address, 1n),
      ).to.not.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });
  });
});

describe("Integration: LazyOracle Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agent: HardhatEthersSigner;
  let sanityParamsUpdater: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let lazyOracle: LazyOracle;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    lazyOracle = ctx.contracts.lazyOracle;

    // Get DAO agent - it has DEFAULT_ADMIN_ROLE on LazyOracle
    agent = await ctx.getSigner("agent");

    [sanityParamsUpdater, stranger] = await ethers.getSigners();

    // Grant UPDATE_SANITY_PARAMS_ROLE from agent
    await lazyOracle.connect(agent).grantRole(await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(), sanityParamsUpdater);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Role-protected methods", () => {
    it("updateSanityParams - requires UPDATE_SANITY_PARAMS_ROLE", async () => {
      const method = "updateSanityParams";
      const args: [bigint, bigint, bigint] = [days(1n), 100n, ether("0.01")];

      // Should fail for non-role holders
      await expect(lazyOracle.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(lazyOracle, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await lazyOracle.UPDATE_SANITY_PARAMS_ROLE());

      // Should succeed for role holder
      await expect(lazyOracle.connect(sanityParamsUpdater)[method](...args)).to.not.be.revertedWithCustomError(
        lazyOracle,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("Special sender-protected methods", () => {
    it("updateReportData - requires AccountingOracle as sender", async () => {
      const method = "updateReportData";
      const args: [bigint, bigint, string, string] = [
        BigInt(Math.floor(Date.now() / 1000)),
        1000n,
        "0x" + "0".repeat(64),
        "QmTest",
      ];

      // Should fail for unauthorized callers
      await expect(lazyOracle.connect(stranger)[method](...args)).to.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );

      // Should succeed for AccountingOracle
      const accountingOracleSigner = await impersonate(await ctx.contracts.accountingOracle.getAddress(), ether("10"));
      await expect(lazyOracle.connect(accountingOracleSigner)[method](...args)).to.not.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );
    });

    it("removeVaultQuarantine - requires VaultHub as sender", async () => {
      const method = "removeVaultQuarantine";
      const args: [string] = [ZeroAddress];

      // Should fail for unauthorized callers
      await expect(lazyOracle.connect(stranger)[method](...args)).to.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );

      // Should succeed for VaultHub
      const vaultHubSigner = await impersonate(await ctx.contracts.vaultHub.getAddress(), ether("10"));
      await expect(lazyOracle.connect(vaultHubSigner)[method](...args)).to.not.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );
    });
  });

  describe("Permissionless methods", () => {
    it("updateVaultData - anyone can call with valid proof", async () => {
      // This method is permissionless and uses merkle proof for validation
      // We just verify that it doesn't revert with NotAuthorized for stranger
      // (it will fail with InvalidProof, but that's expected)
      const method = "updateVaultData";
      const args: [string, bigint, bigint, bigint, bigint, bigint, string[]] = [ZeroAddress, 0n, 0n, 0n, 0n, 0n, []];

      // Should not revert with NotAuthorized (will revert with InvalidProof instead)
      await expect(lazyOracle.connect(stranger)[method](...args)).to.not.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );
    });
  });
});

describe("Integration: OperatorGrid Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agent: HardhatEthersSigner;
  let registryRole: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

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
    it("setConfirmExpiry - requires REGISTRY_ROLE", async () => {
      const method = "setConfirmExpiry";
      const args: [bigint] = [days(1n)];

      // Should fail for non-role holders
      await expect(operatorGrid.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await operatorGrid.REGISTRY_ROLE());

      // Should succeed for role holder
      await expect(operatorGrid.connect(registryRole)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("registerGroup - requires REGISTRY_ROLE", async () => {
      const method = "registerGroup";
      const [newOperator] = await ethers.getSigners();
      const args: [string, bigint] = [newOperator.address, ether("1000")];

      // Should fail for non-role holders
      await expect(operatorGrid.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await operatorGrid.REGISTRY_ROLE());

      // Should succeed for role holder
      await expect(operatorGrid.connect(registryRole)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("updateGroupShareLimit - requires REGISTRY_ROLE", async () => {
      const method = "updateGroupShareLimit";
      // First register a group
      const [newOperator] = await ethers.getSigners();
      await operatorGrid.connect(registryRole).registerGroup(newOperator.address, ether("1000"));

      const args: [string, bigint] = [newOperator.address, ether("2000")];

      // Should fail for non-role holders
      await expect(operatorGrid.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await operatorGrid.REGISTRY_ROLE());

      // Should succeed for role holder
      await expect(operatorGrid.connect(registryRole)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("registerTiers - requires REGISTRY_ROLE", async () => {
      const method = "registerTiers";
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
      const args: [string, typeof tierParams] = [newOperator.address, tierParams];

      // Should fail for non-role holders
      await expect(operatorGrid.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await operatorGrid.REGISTRY_ROLE());

      // Should succeed for role holder
      await expect(operatorGrid.connect(registryRole)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("alterTiers - requires REGISTRY_ROLE", async () => {
      const method = "alterTiers";
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
      const args: [bigint[], typeof tierParams] = [[0n], tierParams];

      // Should fail for non-role holders
      await expect(operatorGrid.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await operatorGrid.REGISTRY_ROLE());

      // Should succeed for role holder
      await expect(operatorGrid.connect(registryRole)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("updateVaultFees - requires REGISTRY_ROLE", async () => {
      const method = "updateVaultFees";
      const args: [string, bigint, bigint, bigint] = [vaultAddress, 200n, 200n, 200n];

      // Should fail for non-role holders
      await expect(operatorGrid.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await operatorGrid.REGISTRY_ROLE());

      // Should succeed for role holder (but might fail for other reasons)
      await expect(operatorGrid.connect(registryRole)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("setVaultJailStatus - requires REGISTRY_ROLE", async () => {
      const method = "setVaultJailStatus";
      const args: [string, boolean] = [vaultAddress, true];

      // Should fail for non-role holders
      await expect(operatorGrid.connect(stranger)[method](...args))
        .to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await operatorGrid.REGISTRY_ROLE());

      // Should succeed for role holder
      await expect(operatorGrid.connect(registryRole)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("Special sender-protected methods", () => {
    it("onMintedShares - requires VaultHub as sender", async () => {
      const method = "onMintedShares";
      const args: [string, bigint, boolean] = [vaultAddress, 100n, false];

      // Should fail for unauthorized callers
      await expect(operatorGrid.connect(stranger)[method](...args)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

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
      await expect(operatorGrid.connect(stranger)[method](...args)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

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
      await expect(operatorGrid.connect(stranger)[method](...args)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

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
      // This method requires confirmations from both vault owner and node operator
      const method = "changeTier";
      const args: [string, bigint, bigint] = [vaultAddress, 0n, ether("100")];

      // Should not revert with NotAuthorized for stranger (will collect confirmation or fail for other reasons)
      await expect(operatorGrid.connect(stranger)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

      // Should not revert with NotAuthorized for vault owner
      // we use dashboard here becouse it is the vault owner when vault is connected to vault hub
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(operatorGrid.connect(dashboardSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

      // Should not revert with NotAuthorized for node operator
      await expect(operatorGrid.connect(nodeOperator)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("syncTier - requires vault owner and node operator confirmations", async () => {
      // This method requires confirmations from both vault owner and node operator
      const method = "syncTier";
      const args: [string] = [vaultAddress];

      // Should not revert with NotAuthorized for stranger (will collect confirmation or fail for other reasons)
      await expect(operatorGrid.connect(stranger)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

      // Should not revert with NotAuthorized for vault owner
      // we use dashboard here becouse it is the vault owner when vault is connected to vault hub
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(operatorGrid.connect(dashboardSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

      // Should not revert with NotAuthorized for node operator
      await expect(operatorGrid.connect(nodeOperator)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("updateVaultShareLimit - requires vault owner and node operator confirmations", async () => {
      // This method requires confirmations from both vault owner and node operator
      const method = "updateVaultShareLimit";
      const args: [string, bigint] = [vaultAddress, ether("200")];

      // Should not revert with NotAuthorized for stranger (will collect confirmation or fail for other reasons)
      await expect(operatorGrid.connect(stranger)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

      // Should not revert with NotAuthorized for vault owner
      // we use dashboard here becouse it is the vault owner when vault is connected to vault hub
      const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("10"));
      await expect(operatorGrid.connect(dashboardSigner)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );

      // Should not revert with NotAuthorized for node operator
      await expect(operatorGrid.connect(nodeOperator)[method](...args)).to.not.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });
  });
});
