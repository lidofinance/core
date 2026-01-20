import { expect } from "chai";
import { ContractMethodArgs, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard } from "typechain-types";

import { days, ether, MAX_SANE_SETTLED_GROWTH, PDGPolicy, randomValidatorPubkey } from "lib";
import {
  autofillRoles,
  createVaultWithDashboard,
  getProtocolContext,
  getRoleMethods,
  Methods,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  testMethod,
  VaultRoles,
} from "lib/protocol";
import { vaultRoleKeys } from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            await ctx.contracts.lido.connect(roles.minter).transfer(user, stethAmount);
            await ctx.contracts.lido.connect(user).approve(dashboard, stethAmount);
          }

          await testMethod(
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
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
            dashboard,
            "disburseAbnormallyHighFee",
            {
              successUsers: [owner],
              failingUsers: [...Object.values(roles), nodeOperatorManager, stranger],
            },
            [],
            await dashboard.DEFAULT_ADMIN_ROLE(),
          );
        });

        it("abandonDashboard - requires DEFAULT_ADMIN_ROLE", async () => {
          // Setup: disconnect vault from hub first
          const { vaultHub } = ctx.contracts;
          const stakingVaultAddress = await dashboard.stakingVault();
          const stakingVault = await ethers.getContractAt("StakingVault", stakingVaultAddress);

          // Disconnect vault if connected
          if (await vaultHub.isVaultConnected(stakingVaultAddress)) {
            // Use voluntaryDisconnect to disconnect
            await dashboard.connect(roles.disconnecter).voluntaryDisconnect();
            // Complete disconnect by reporting
            await reportVaultDataWithProof(ctx, stakingVault);
            // Verify vault is disconnected
            expect(await vaultHub.isVaultConnected(stakingVaultAddress)).to.be.false;
          }

          await testMethod(
            dashboard,
            "abandonDashboard",
            {
              successUsers: [owner],
              failingUsers: [...Object.values(roles), nodeOperatorManager, stranger],
            },
            [stranger.address],
            await dashboard.DEFAULT_ADMIN_ROLE(),
          );
        });

        it("reconnectToVaultHub - requires DEFAULT_ADMIN_ROLE", async () => {
          // Setup: disconnect vault from hub and correct settled growth
          const { vaultHub } = ctx.contracts;
          const stakingVaultAddress = await dashboard.stakingVault();
          const stakingVault = await ethers.getContractAt("StakingVault", stakingVaultAddress);

          // Disconnect vault if connected
          if (await vaultHub.isVaultConnected(stakingVaultAddress)) {
            await dashboard.connect(roles.disconnecter).voluntaryDisconnect();
            // Complete disconnect by reporting
            await reportVaultDataWithProof(ctx, stakingVault);
            // Verify vault is disconnected
            expect(await vaultHub.isVaultConnected(stakingVaultAddress)).to.be.false;
          }

          // Correct settled growth only if needed
          const currentSettledGrowth = await dashboard.settledGrowth();
          if (currentSettledGrowth >= MAX_SANE_SETTLED_GROWTH) {
            await dashboard.connect(owner).correctSettledGrowth(0n, MAX_SANE_SETTLED_GROWTH);
            await dashboard.connect(nodeOperatorManager).correctSettledGrowth(0n, MAX_SANE_SETTLED_GROWTH);
          }

          await testMethod(
            dashboard,
            "reconnectToVaultHub",
            {
              successUsers: [owner],
              failingUsers: [...Object.values(roles), nodeOperatorManager, stranger],
            },
            [],
            await dashboard.DEFAULT_ADMIN_ROLE(),
          );
        });

        it("connectToVaultHub - requires DEFAULT_ADMIN_ROLE (via ownership)", async () => {
          // Setup: disconnect vault from hub and correct settled growth
          const { vaultHub } = ctx.contracts;
          const stakingVaultAddress = await dashboard.stakingVault();
          const stakingVault = await ethers.getContractAt("StakingVault", stakingVaultAddress);

          // Disconnect vault if connected
          if (await vaultHub.isVaultConnected(stakingVaultAddress)) {
            await dashboard.connect(roles.disconnecter).voluntaryDisconnect();
            // Complete disconnect by reporting
            await reportVaultDataWithProof(ctx, stakingVault);
            // Verify vault is disconnected
            expect(await vaultHub.isVaultConnected(stakingVaultAddress)).to.be.false;
          }

          // Correct settled growth only if needed
          const currentSettledGrowth = await dashboard.settledGrowth();
          if (currentSettledGrowth >= MAX_SANE_SETTLED_GROWTH) {
            await dashboard.connect(owner).correctSettledGrowth(0n, MAX_SANE_SETTLED_GROWTH);
            await dashboard.connect(nodeOperatorManager).correctSettledGrowth(0n, MAX_SANE_SETTLED_GROWTH);
          }

          // connectToVaultHub is public but requires ownership, so only owner (DEFAULT_ADMIN) can call it
          await testMethod(
            dashboard,
            "connectToVaultHub",
            {
              successUsers: [owner],
              failingUsers: [...Object.values(roles), nodeOperatorManager, stranger],
            },
            [{ value: 0n }],
            await dashboard.DEFAULT_ADMIN_ROLE(),
          );
        });

        it("connectAndAcceptTier - requires VAULT_CONFIGURATION_ROLE", async () => {
          // Setup: disconnect vault from hub, correct settled growth, and register tier
          const { vaultHub, operatorGrid } = ctx.contracts;
          const stakingVaultAddress = await dashboard.stakingVault();
          const stakingVault = await ethers.getContractAt("StakingVault", stakingVaultAddress);
          const agent = await ctx.getSigner("agent");

          // Disconnect vault if connected
          if (await vaultHub.isVaultConnected(stakingVaultAddress)) {
            await dashboard.connect(roles.disconnecter).voluntaryDisconnect();
            // Complete disconnect by reporting
            await reportVaultDataWithProof(ctx, stakingVault);
            // Verify vault is disconnected
            expect(await vaultHub.isVaultConnected(stakingVaultAddress)).to.be.false;
          }

          // Correct settled growth only if needed
          const currentSettledGrowth = await dashboard.settledGrowth();
          if (currentSettledGrowth >= MAX_SANE_SETTLED_GROWTH) {
            await dashboard.connect(owner).correctSettledGrowth(0n, MAX_SANE_SETTLED_GROWTH);
            await dashboard.connect(nodeOperatorManager).correctSettledGrowth(0n, MAX_SANE_SETTLED_GROWTH);
          }

          // Register group and tier for nodeOperatorManager
          const nodeOperatorAddress = await stakingVault.nodeOperator();
          await operatorGrid.connect(agent).grantRole(await operatorGrid.REGISTRY_ROLE(), agent);
          await operatorGrid.connect(agent).registerGroup(nodeOperatorAddress, ether("5000"));
          await operatorGrid.connect(agent).registerTiers(nodeOperatorAddress, [
            {
              shareLimit: ether("1000"),
              reserveRatioBP: 1000n,
              forcedRebalanceThresholdBP: 500n,
              infraFeeBP: 100n,
              liquidityFeeBP: 100n,
              reservationFeeBP: 100n,
            },
          ]);
          const tierId = (await operatorGrid.group(nodeOperatorAddress)).tierIds[0];

          // connectAndAcceptTier first calls connectToVaultHub() which requires DEFAULT_ADMIN_ROLE
          // So the first access check is for DEFAULT_ADMIN_ROLE, not VAULT_CONFIGURATION_ROLE
          await testMethod(
            dashboard,
            "connectAndAcceptTier",
            {
              successUsers: [owner],
              failingUsers: [...Object.values(roles), nodeOperatorManager, stranger],
            },
            [tierId, ether("100"), { value: 0n }],
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
            failingUsers: [...Object.values(roles), stranger],
          },
          [stranger.address],
        );
      });

      it("correctSettledGrowth confirmations", async () => {
        await testMethodConfirmedRoles(
          "correctSettledGrowth",
          {
            successUsers: [owner, nodeOperatorManager],
            failingUsers: [...Object.values(roles), stranger],
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

  async function testMethodConfirmedRoles<T extends unknown[]>(
    methodName: Methods<Dashboard>,
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
    methodName: Methods<Dashboard>,
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
