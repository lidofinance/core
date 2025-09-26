import { expect } from "chai";
import { ContractMethodArgs, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard } from "typechain-types";

import { days, ether, PDGPolicy, randomValidatorPubkey } from "lib";
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

    describe.skip("Verify ACL for methods that require only role", () => {
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

  // initializing contracts without signers
  describe("No roles are assigned", () => {
    it("Verify that roles are not assigned", async () => {
      const roleMethods = getRoleMethods(dashboard);

      for (const role of vaultRoleKeys) {
        expect(await dashboard.getRoleMembers(await roleMethods[role])).to.deep.equal([], `Role "${role}" is assigned`);
      }
    });

    describe.skip("Verify ACL for methods that require only role", () => {
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
              failingUsers: Object.values(roles).filter((r) => r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== owner && r !== roles.assetCollector),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.validatorWithdrawalTriggerer && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.validatorExitRequester && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.depositResumer && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.depositPauser && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.rebalancer && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.rebalancer && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.minter && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.minter && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.minter && r !== owner),
            },
            [stranger, 100n],
            await dashboard.MINT_ROLE(),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.withdrawer && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.funder && r !== owner),
            },
            [{ value: 1n }],
            await dashboard.FUND_ROLE(),
          );
        });

        //TODO: burnWstETH, burnStETH, burnShares

        it("voluntaryDisconnect", async () => {
          await testMethod(
            "voluntaryDisconnect",
            {
              successUsers: [roles.disconnecter, owner],
              failingUsers: Object.values(roles).filter((r) => r !== roles.disconnecter && r !== owner),
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
              failingUsers: Object.values(roles).filter((r) => r !== roles.tierChanger && r !== owner),
            },
            [1n, 1n],
            await dashboard.VAULT_CONFIGURATION_ROLE(),
          );
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
            successUsers: [],
            failingUsers: Object.values(roles).filter((r) => r !== owner && r !== nodeOperatorManager),
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
            successUsers: [],
            failingUsers: Object.values(roles).filter((r) => r !== owner && r !== nodeOperatorManager),
          },
          [days(7n)],
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
