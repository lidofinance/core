import { expect } from "chai";
import { ContractMethodArgs, Interface, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting,
  Dashboard,
  LazyOracle,
  OperatorGrid,
  PredepositGuarantee,
  StakingVault,
  VaultHub,
} from "typechain-types";

import { days, ether, impersonate, MAX_SANE_SETTLED_GROWTH, PDGPolicy, randomValidatorPubkey } from "lib";
import {
  autofillRoles,
  createVaultWithDashboard,
  ensurePredepositGuaranteeUnpaused,
  getProtocolContext,
  getRoleMethods,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  VaultRoles,
} from "lib/protocol";
import { vaultRoleKeys } from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

// Helper type to extract method names from a contract
type Methods<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]: T[K] extends (...args: any) => any ? K : never;
}[keyof T];

// Helper functions for testing access control
async function testMethod<
  T extends unknown[],
  C extends { connect: (signer: HardhatEthersSigner) => C; interface: Interface },
>(
  contract: C,
  methodName: Methods<C> & string,
  { successUsers, failingUsers }: { successUsers: HardhatEthersSigner[]; failingUsers: HardhatEthersSigner[] },
  argument: T,
  requiredRole: string,
  errorName = "AccessControlUnauthorizedAccount",
) {
  for (const user of failingUsers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((contract.connect(user) as any)[methodName](...(argument as ContractMethodArgs<T>)))
      .to.be.revertedWithCustomError(contract, errorName)
      .withArgs(user, requiredRole);
  }

  for (const user of successUsers) {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (contract.connect(user) as any)[methodName](...(argument as ContractMethodArgs<T>)),
    ).to.not.be.revertedWithCustomError(contract, errorName);
  }
}

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
      // This role is granted to agent on Hoodi testnet
      if (await lazyOracle.hasRole(await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(), agent.address)) {
        await lazyOracle.connect(agent).revokeRole(await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(), agent.address);
      }
      await testMethod(
        lazyOracle,
        "updateSanityParams",
        {
          successUsers: [sanityParamsUpdater],
          failingUsers: [stranger, agent],
        },
        [days(1n), 100n, ether("0.01")],
        await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(),
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
      for (const user of [stranger, agent, sanityParamsUpdater]) {
        await expect(lazyOracle.connect(user)[method](...args)).to.be.revertedWithCustomError(
          lazyOracle,
          "NotAuthorized",
        );
      }

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
      for (const user of [stranger, agent, sanityParamsUpdater]) {
        await expect(lazyOracle.connect(user)[method](...args)).to.be.revertedWithCustomError(
          lazyOracle,
          "NotAuthorized",
        );
      }

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

describe("Integration: Accounting Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let stranger: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  let accounting: Accounting;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    agent = await ctx.getSigner("agent");

    accounting = ctx.contracts.accounting;

    [stranger] = await ethers.getSigners();
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Special sender-protected methods", () => {
    it("handleOracleReport - requires AccountingOracle as sender", async () => {
      const method = "handleOracleReport";
      // Minimal report structure (will fail for other reasons but not NotAuthorized for stranger)
      const report = {
        timestamp: 0n,
        timeElapsed: 0n,
        clValidators: 0n,
        clBalance: 0n,
        withdrawalVaultBalance: 0n,
        elRewardsVaultBalance: 0n,
        sharesRequestedToBurn: 0n,
        withdrawalFinalizationBatches: [],
        simulatedShareRate: 0n,
      };
      const args: [typeof report] = [report];

      // Should fail for unauthorized callers
      for (const user of [stranger, agent]) {
        await expect(accounting.connect(user)[method](...args)).to.be.revertedWithCustomError(
          accounting,
          "NotAuthorized",
        );
      }

      // Should succeed for AccountingOracle
      const accountingOracleSigner = await impersonate(await ctx.contracts.accountingOracle.getAddress(), ether("10"));
      await expect(accounting.connect(accountingOracleSigner)[method](...args)).to.not.be.revertedWithCustomError(
        accounting,
        "NotAuthorized",
      );
    });
  });
});

describe("Integration: PredepositGuarantee Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agent: HardhatEthersSigner;
  let pauseRole: HardhatEthersSigner;
  let resumeRole: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let depositor: HardhatEthersSigner;
  let roles: HardhatEthersSigner[];

  let predepositGuarantee: PredepositGuarantee;
  let stakingVault: StakingVault;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    await ensurePredepositGuaranteeUnpaused(ctx);

    predepositGuarantee = ctx.contracts.predepositGuarantee;

    // Get DAO agent - it has DEFAULT_ADMIN_ROLE on PredepositGuarantee
    agent = await ctx.getSigner("agent");

    [pauseRole, resumeRole, stranger, nodeOperator, depositor] = await ethers.getSigners();

    // Grant roles from agent
    await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.PAUSE_ROLE(), pauseRole);
    await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.RESUME_ROLE(), resumeRole);

    roles = [pauseRole, resumeRole, stranger, nodeOperator, depositor];

    // Create a vault for testing
    const [vaultOwner] = await ethers.getSigners();
    ({ stakingVault } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      vaultOwner,
      nodeOperator,
      nodeOperator,
    ));

    // Set depositor for node operator
    await predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(depositor);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Role-protected methods", () => {
    it("pauseFor - requires PAUSE_ROLE", async () => {
      await testMethod(
        predepositGuarantee,
        "pauseFor",
        {
          successUsers: [pauseRole],
          failingUsers: [...roles.filter((r) => r !== pauseRole), agent],
        },
        [days(1n)],
        await predepositGuarantee.PAUSE_ROLE(),
      );
    });

    it("pauseUntil - requires PAUSE_ROLE", async () => {
      const futureTimestamp = BigInt(Math.floor(Date.now() / 1000) + 86400);
      await testMethod(
        predepositGuarantee,
        "pauseUntil",
        {
          successUsers: [pauseRole],
          failingUsers: [...roles.filter((r) => r !== pauseRole), agent],
        },
        [futureTimestamp],
        await predepositGuarantee.PAUSE_ROLE(),
      );
    });

    it("resume - requires RESUME_ROLE", async () => {
      // First pause the contract
      await predepositGuarantee.connect(pauseRole).pauseFor(days(1n));

      await testMethod(
        predepositGuarantee,
        "resume",
        {
          successUsers: [resumeRole],
          failingUsers: [...roles.filter((r) => r !== resumeRole), agent],
        },
        [],
        await predepositGuarantee.RESUME_ROLE(),
      );
    });
  });

  describe("Sender-specific methods", () => {
    it("predeposit - requires depositor for node operator", async () => {
      const method = "predeposit";
      const deposits = [
        {
          pubkey: randomValidatorPubkey(),
          amount: ether("1"),
          signature: new Uint8Array(96),
          depositDataRoot: new Uint8Array(32),
        },
      ];
      const depositsY = [
        {
          pubkeyY: {
            a: "0x" + "0".repeat(64),
            b: "0x" + "0".repeat(64),
          },
          signatureY: {
            c0_a: "0x" + "0".repeat(64),
            c0_b: "0x" + "0".repeat(64),
            c1_a: "0x" + "0".repeat(64),
            c1_b: "0x" + "0".repeat(64),
          },
        },
      ];
      const args: [typeof stakingVault, typeof deposits, typeof depositsY] = [stakingVault, deposits, depositsY];

      // Should fail for non-depositor
      for (const user of [...roles.filter((r) => r !== depositor), agent]) {
        await expect(predepositGuarantee.connect(user)[method](...args)).to.be.revertedWithCustomError(
          predepositGuarantee,
          "NotDepositor",
        );
      }

      // Should succeed for depositor (but might fail for other reasons like balance)
      await expect(predepositGuarantee.connect(depositor)[method](...args)).to.not.be.revertedWithCustomError(
        predepositGuarantee,
        "NotDepositor",
      );
    });

    it("proveUnknownValidator - requires staking vault owner", async () => {
      const method = "proveUnknownValidator";
      const witness = {
        proof: [
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        ],
        pubkey: "0x",
        validatorIndex: 0n,
        childBlockTimestamp: 0n,
        slot: 0n,
        proposerIndex: 0n,
      };
      const args: [typeof witness, typeof stakingVault] = [witness, stakingVault];

      // Should fail for non-owner
      for (const user of [...roles, agent]) {
        await expect(predepositGuarantee.connect(user)[method](...args)).to.be.revertedWithCustomError(
          predepositGuarantee,
          "NotStakingVaultOwner",
        );
      }

      // Should succeed for vault owner (VaultHub, since vault is connected to VaultHub)
      const vaultOwner = await stakingVault.owner();
      const vaultOwnerSigner = await impersonate(vaultOwner, ether("10"));
      await expect(predepositGuarantee.connect(vaultOwnerSigner)[method](...args)).to.not.be.revertedWithCustomError(
        predepositGuarantee,
        "NotStakingVaultOwner",
      );
    });

    it("topUpExistingValidators - requires depositor for node operator of each validator", async () => {
      const method = "topUpExistingValidators";
      const topUps = [
        {
          pubkey: randomValidatorPubkey(),
          amount: ether("1"),
        },
      ];
      const args: [typeof topUps] = [topUps];

      // Should fail for unauthorized users (not a depositor)
      for (const user of [...roles, agent]) {
        await expect(predepositGuarantee.connect(user)[method](...args)).to.be.revertedWithCustomError(
          predepositGuarantee,
          "NotDepositor",
        );
      }

      // Note: To properly test that depositor can call this, we would need a fully activated validator
      // with nodeOperator set, which is beyond the scope of this ACL test
    });

    it("topUpNodeOperatorBalance - requires guarantor", async () => {
      const method = "topUpNodeOperatorBalance";
      const args: [string] = [nodeOperator.address];

      // Should fail for unauthorized users (not a guarantor)
      for (const user of [...roles.filter((r) => r !== nodeOperator), agent]) {
        await expect(
          predepositGuarantee.connect(user)[method](...args, { value: ether("1") }),
        ).to.be.revertedWithCustomError(predepositGuarantee, "NotGuarantor");
      }

      // Should succeed for node operator (default guarantor is the node operator itself)
      await expect(predepositGuarantee.connect(nodeOperator)[method](...args, { value: ether("1") })).to.not.be
        .reverted;
    });

    it("setNodeOperatorGuarantor - can be called by node operator", async () => {
      const method = "setNodeOperatorGuarantor";
      const [newGuarantor] = await ethers.getSigners();
      const args: [string] = [newGuarantor.address];

      // Should succeed for node operator (permissionless for the node operator to set their own guarantor)
      await expect(predepositGuarantee.connect(nodeOperator)[method](...args)).to.not.be.reverted;
    });

    it("setNodeOperatorDepositor - can be called by node operator", async () => {
      const method = "setNodeOperatorDepositor";
      const [newDepositor] = await ethers.getSigners();
      const args: [string] = [newDepositor.address];

      // Should succeed for node operator (permissionless for the node operator to set their own depositor)
      await expect(predepositGuarantee.connect(nodeOperator)[method](...args)).to.not.be.reverted;
    });
  });
});
