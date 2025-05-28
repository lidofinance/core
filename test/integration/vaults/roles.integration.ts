import { expect } from "chai";
import { ContractMethodArgs, ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard } from "typechain-types";

import { days, ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

const VAULT_NODE_OPERATOR_FEE = 1_00n; // 3% node operator fee

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

const VAULT_CONNECTION_DEPOSIT = ether("1");

type Methods<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]: T[K] extends (...args: any) => any ? K : never;
}[keyof T];

type DashboardMethods = Methods<Dashboard>; // "foo" | "bar"

describe("Integration: Staking Vaults Dashboard Roles Initial Setup", () => {
  let ctx: ProtocolContext;

  let snapshot: string;

  let owner: HardhatEthersSigner,
    nodeOperatorManager: HardhatEthersSigner,
    funder: HardhatEthersSigner,
    withdrawer: HardhatEthersSigner,
    assetRecoverer: HardhatEthersSigner,
    minter: HardhatEthersSigner,
    burner: HardhatEthersSigner,
    rebalancer: HardhatEthersSigner,
    depositPauser: HardhatEthersSigner,
    depositResumer: HardhatEthersSigner,
    pdgCompensator: HardhatEthersSigner,
    unknownValidatorProver: HardhatEthersSigner,
    unguaranteedBeaconChainDepositor: HardhatEthersSigner,
    validatorExitRequester: HardhatEthersSigner,
    validatorWithdrawalTriggerer: HardhatEthersSigner,
    disconnecter: HardhatEthersSigner,
    tierChanger: HardhatEthersSigner,
    nodeOperatorFeeRecipientSetter: HardhatEthersSigner,
    nodeOperatorRewardAdjuster: HardhatEthersSigner,
    stranger: HardhatEthersSigner;

  let allRoles: HardhatEthersSigner[];

  before(async () => {
    ctx = await getProtocolContext();

    allRoles = await ethers.getSigners();
    [
      owner,
      nodeOperatorManager,
      assetRecoverer,
      funder,
      withdrawer,
      minter,
      burner,
      rebalancer,
      depositPauser,
      depositResumer,
      pdgCompensator,
      unknownValidatorProver,
      unguaranteedBeaconChainDepositor,
      validatorExitRequester,
      validatorWithdrawalTriggerer,
      disconnecter,
      tierChanger,
      nodeOperatorFeeRecipientSetter,
      nodeOperatorRewardAdjuster,
      stranger,
    ] = allRoles;
  });

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  // initializing contracts with signers
  describe("Vault created with all the roles", () => {
    let testDashboard: Dashboard;

    before(async () => {
      const { stakingVaultFactory } = ctx.contracts;

      // Owner can create a vault with operator as a node operator
      const deployTx = await stakingVaultFactory
        .connect(owner)
        .createVaultWithDashboard(
          owner,
          nodeOperatorManager,
          nodeOperatorManager,
          VAULT_NODE_OPERATOR_FEE,
          days(7n),
          [],
          { value: VAULT_CONNECTION_DEPOSIT },
        );

      const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
      const createDashboardEvent = ctx.getEvents(createVaultTxReceipt, "DashboardCreated")[0];
      testDashboard = await ethers.getContractAt("Dashboard", createDashboardEvent.args?.dashboard);

      await testDashboard.connect(owner).grantRoles([
        {
          account: assetRecoverer,
          role: await testDashboard.RECOVER_ASSETS_ROLE(),
        },
        {
          account: funder,
          role: await testDashboard.FUND_ROLE(),
        },
        {
          account: withdrawer,
          role: await testDashboard.WITHDRAW_ROLE(),
        },
        {
          account: minter,
          role: await testDashboard.MINT_ROLE(),
        },
        {
          account: burner,
          role: await testDashboard.BURN_ROLE(),
        },
        {
          account: rebalancer,
          role: await testDashboard.REBALANCE_ROLE(),
        },
        {
          account: depositPauser,
          role: await testDashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
        },
        {
          account: depositResumer,
          role: await testDashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
        },
        {
          account: unknownValidatorProver,
          role: await testDashboard.PDG_PROVE_VALIDATOR_ROLE(),
        },
        {
          account: unguaranteedBeaconChainDepositor,
          role: await testDashboard.UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE(),
        },
        {
          account: validatorExitRequester,
          role: await testDashboard.REQUEST_VALIDATOR_EXIT_ROLE(),
        },
        {
          account: validatorWithdrawalTriggerer,
          role: await testDashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
        },
        {
          account: disconnecter,
          role: await testDashboard.VOLUNTARY_DISCONNECT_ROLE(),
        },
        {
          account: tierChanger,
          role: await testDashboard.REQUEST_TIER_CHANGE_ROLE(),
        },
      ]);

      await testDashboard.connect(nodeOperatorManager).grantRoles([
        {
          account: nodeOperatorFeeRecipientSetter,
          role: await testDashboard.NODE_OPERATOR_FEE_RECIPIENT_SET_ROLE(),
        },
        {
          account: nodeOperatorRewardAdjuster,
          role: await testDashboard.NODE_OPERATOR_REWARDS_ADJUST_ROLE(),
        },
      ]);
    });

    it("Allows anyone to read public metrics of the vault", async () => {
      expect(await testDashboard.connect(funder).nodeOperatorDisbursableFee()).to.equal(0);
      expect(await testDashboard.connect(funder).withdrawableEther()).to.equal(0);
    });

    it("Allows to retrieve roles addresses", async () => {
      expect(await testDashboard.getRoleMembers(await testDashboard.MINT_ROLE())).to.deep.equal([minter.address]);
    });

    it("Allows NO Manager to add and remove new managers", async () => {
      await testDashboard
        .connect(nodeOperatorManager)
        .grantRole(await testDashboard.NODE_OPERATOR_MANAGER_ROLE(), stranger);
      expect(await testDashboard.getRoleMembers(await testDashboard.NODE_OPERATOR_MANAGER_ROLE())).to.deep.equal([
        nodeOperatorManager.address,
        stranger.address,
      ]);
      await testDashboard
        .connect(nodeOperatorManager)
        .revokeRole(await testDashboard.NODE_OPERATOR_MANAGER_ROLE(), stranger);
      expect(await testDashboard.getRoleMembers(await testDashboard.NODE_OPERATOR_MANAGER_ROLE())).to.deep.equal([
        nodeOperatorManager.address,
      ]);
    });

    describe("Verify ACL for methods that require only role", () => {
      describe("Dashboard methods", () => {
        it("claimNodeOperatorFee", async () => {
          // TODO:
          // await testMethod(
          //   testDashboard,
          //   "claimNodeOperatorFee",
          //   {
          //     successUsers: [nodeOperatorFeeClaimer],
          //     failingUsers: allRoles.filter((r) => r !== nodeOperatorFeeClaimer),
          //   },
          //   [stranger],
          //   await testDashboard.NODE_OPERATOR_FEE_CLAIM_ROLE(),
          //);
        });
      });

      describe("Dashboard methods", () => {
        it("recoverERC20", async () => {
          await testMethod(
            testDashboard,
            "recoverERC20",
            {
              successUsers: [assetRecoverer, owner],
              failingUsers: allRoles.filter((r) => r !== assetRecoverer && r !== owner),
            },
            [ZeroAddress, owner, 1n],
            await testDashboard.RECOVER_ASSETS_ROLE(),
          );
        });

        it("recoverERC721", async () => {
          await testMethod(
            testDashboard,
            "recoverERC721",
            {
              successUsers: [assetRecoverer, owner],
              failingUsers: allRoles.filter((r) => r !== assetRecoverer && r !== owner),
            },
            [ZeroAddress, 0, stranger],
            await testDashboard.RECOVER_ASSETS_ROLE(),
          );
        });

        it("triggerValidatorWithdrawal", async () => {
          await testMethod(
            testDashboard,
            "triggerValidatorWithdrawals",
            {
              successUsers: [validatorWithdrawalTriggerer, owner],
              failingUsers: allRoles.filter((r) => r !== validatorWithdrawalTriggerer && r !== owner),
            },
            ["0x", [0n], stranger],
            await testDashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
          );
        });

        it("requestValidatorExit", async () => {
          await testMethod(
            testDashboard,
            "requestValidatorExit",
            {
              successUsers: [validatorExitRequester, owner],
              failingUsers: allRoles.filter((r) => r !== validatorExitRequester && r !== owner),
            },
            ["0x" + "ab".repeat(48)],
            await testDashboard.REQUEST_VALIDATOR_EXIT_ROLE(),
          );
        });

        it("resumeBeaconChainDeposits", async () => {
          await testMethod(
            testDashboard,
            "resumeBeaconChainDeposits",
            {
              successUsers: [depositResumer, owner],
              failingUsers: allRoles.filter((r) => r !== depositResumer && r !== owner),
            },
            [],
            await testDashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
          );
        });

        it("pauseBeaconChainDeposits", async () => {
          await testMethod(
            testDashboard,
            "pauseBeaconChainDeposits",
            {
              successUsers: [depositPauser, owner],
              failingUsers: allRoles.filter((r) => r !== depositPauser && r !== owner),
            },
            [],
            await testDashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("compensateDisprovenPredepositFromPDG", async () => {
          await testMethod(
            testDashboard,
            "compensateDisprovenPredepositFromPDG",
            {
              successUsers: [pdgCompensator, owner],
              failingUsers: allRoles.filter((r) => r !== pdgCompensator && r !== owner),
            },
            [SAMPLE_PUBKEY, stranger],
            await testDashboard.PDG_COMPENSATE_PREDEPOSIT_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("proveUnknownValidatorsToPDG", async () => {
          await testMethod(
            testDashboard,
            "proveUnknownValidatorsToPDG",
            {
              successUsers: [unknownValidatorProver, owner],
              failingUsers: allRoles.filter((r) => r !== unknownValidatorProver && r !== owner),
            },
            [SAMPLE_PUBKEY, stranger],
            await testDashboard.PDG_PROVE_VALIDATOR_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("increaseAccruedRewardsAdjustment", async () => {
          await testMethod(
            testDashboard,
            "increaseAccruedRewardsAdjustment",
            {
              successUsers: [nodeOperatorRewardAdjuster, nodeOperatorManager],
              failingUsers: allRoles.filter((r) => r !== nodeOperatorRewardAdjuster && r !== nodeOperatorManager),
            },
            [SAMPLE_PUBKEY, stranger],
            await testDashboard.NODE_OPERATOR_REWARDS_ADJUST_ROLE(),
          );
        });

        it("rebalanceVault", async () => {
          await testMethod(
            testDashboard,
            "rebalanceVault",
            {
              successUsers: [rebalancer, owner],
              failingUsers: allRoles.filter((r) => r !== rebalancer && r !== owner),
            },
            [1n],
            await testDashboard.REBALANCE_ROLE(),
          );
        });

        it("mintWstETH", async () => {
          await testMethod(
            testDashboard,
            "mintWstETH",
            {
              successUsers: [minter, owner],
              failingUsers: allRoles.filter((r) => r !== minter && r !== owner),
            },
            [ZeroAddress, 0, stranger],
            await testDashboard.MINT_ROLE(),
          );
        });

        it("mintStETH", async () => {
          await testMethod(
            testDashboard,
            "mintStETH",
            {
              successUsers: [minter, owner],
              failingUsers: allRoles.filter((r) => r !== minter && r !== owner),
            },
            [stranger, 1n],
            await testDashboard.MINT_ROLE(),
          );
        });

        it("mintShares", async () => {
          await testMethod(
            testDashboard,
            "mintShares",
            {
              successUsers: [minter, owner],
              failingUsers: allRoles.filter((r) => r !== minter && r !== owner),
            },
            [stranger, 100n],
            await testDashboard.MINT_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        // fund 2 ether, cause vault has 1 ether locked already
        it("withdraw", async () => {
          await testDashboard.connect(funder).fund({ value: ether("2") });
          await testMethod(
            testDashboard,
            "withdraw",
            {
              successUsers: [withdrawer, owner],
              failingUsers: allRoles.filter((r) => r !== withdrawer && r !== owner),
            },
            [stranger, ether("1")],
            await testDashboard.WITHDRAW_ROLE(),
          );
        });

        it("fund", async () => {
          await testMethod(
            testDashboard,
            "fund",
            {
              successUsers: [funder, owner],
              failingUsers: allRoles.filter((r) => r !== funder && r !== owner),
            },
            [{ value: 1n }],
            await testDashboard.FUND_ROLE(),
          );
        });

        //TODO: burnWstETH, burnStETH, burnShares

        it("voluntaryDisconnect", async () => {
          await testMethod(
            testDashboard,
            "voluntaryDisconnect",
            {
              successUsers: [disconnecter, owner],
              failingUsers: allRoles.filter((r) => r !== disconnecter && r !== owner),
            },
            [],
            await testDashboard.VOLUNTARY_DISCONNECT_ROLE(),
          );
        });

        it("requestTierChange", async () => {
          await testMethod(
            testDashboard,
            "requestTierChange",
            {
              successUsers: [tierChanger, owner],
              failingUsers: allRoles.filter((r) => r !== tierChanger && r !== owner),
            },
            [1n, 1n],
            await testDashboard.REQUEST_TIER_CHANGE_ROLE(),
          );
        });
      });
    });

    describe("Verify ACL for methods that require confirmations", () => {
      it("setNodeOperatorFeeBP", async () => {
        await expect(testDashboard.connect(owner).setNodeOperatorFeeBP(1n)).not.to.emit(
          testDashboard,
          "NodeOperatorFeeBPSet",
        );
        await expect(testDashboard.connect(nodeOperatorManager).setNodeOperatorFeeBP(1n)).to.emit(
          testDashboard,
          "NodeOperatorFeeBPSet",
        );

        await testMethodConfirmedRoles(
          testDashboard,
          "setNodeOperatorFeeBP",
          {
            successUsers: [],
            failingUsers: allRoles.filter((r) => r !== owner && r !== nodeOperatorManager),
          },
          [1n],
        );
      });

      it("setConfirmExpiry", async () => {
        await expect(testDashboard.connect(owner).setConfirmExpiry(days(7n))).not.to.emit(
          testDashboard,
          "ConfirmExpirySet",
        );
        await expect(testDashboard.connect(nodeOperatorManager).setConfirmExpiry(days(7n))).to.emit(
          testDashboard,
          "ConfirmExpirySet",
        );

        await testMethodConfirmedRoles(
          testDashboard,
          "setConfirmExpiry",
          {
            successUsers: [],
            failingUsers: allRoles.filter((r) => r !== owner && r !== nodeOperatorManager),
          },
          [days(7n)],
        );
      });
    });

    it("Allows anyone to read public metrics of the vault", async () => {
      expect(await testDashboard.connect(funder).nodeOperatorDisbursableFee()).to.equal(0);
      expect(await testDashboard.connect(funder).withdrawableEther()).to.equal(0);
    });

    it("Allows to retrieve roles addresses", async () => {
      expect(await testDashboard.getRoleMembers(await testDashboard.MINT_ROLE())).to.deep.equal([minter.address]);
    });
  });

  // initializing contracts without signers
  describe("Vault created with no roles", () => {
    let testDashboard: Dashboard;

    before(async () => {
      const { stakingVaultFactory } = ctx.contracts;
      allRoles = await ethers.getSigners();

      [owner, stranger] = allRoles;
      // Owner can create a vault with operator as a node operator
      const deployTx = await stakingVaultFactory
        .connect(owner)
        .createVaultWithDashboard(
          owner,
          nodeOperatorManager,
          nodeOperatorManager,
          VAULT_NODE_OPERATOR_FEE,
          days(7n),
          [],
          { value: VAULT_CONNECTION_DEPOSIT },
        );

      const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
      const createDashboardEvent = ctx.getEvents(createVaultTxReceipt, "DashboardCreated")[0];

      testDashboard = await ethers.getContractAt("Dashboard", createDashboardEvent.args?.dashboard);
    });

    it("Verify that roles are not assigned", async () => {
      const roles = await Promise.all([
        testDashboard.FUND_ROLE(),
        testDashboard.WITHDRAW_ROLE(),
        testDashboard.MINT_ROLE(),
        testDashboard.BURN_ROLE(),
        testDashboard.REBALANCE_ROLE(),
        testDashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
        testDashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
        testDashboard.REQUEST_VALIDATOR_EXIT_ROLE(),
        testDashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
        testDashboard.VOLUNTARY_DISCONNECT_ROLE(),
        testDashboard.NODE_OPERATOR_REWARDS_ADJUST_ROLE(),
        testDashboard.UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE(),
        testDashboard.PDG_PROVE_VALIDATOR_ROLE(),
        testDashboard.PDG_COMPENSATE_PREDEPOSIT_ROLE(),
      ]);

      for (const role of roles) {
        expect(await testDashboard.getRoleMembers(role)).to.deep.equal([]);
      }
    });

    describe.skip("Verify ACL for methods that require only role", () => {
      describe("Dashboard methods", () => {
        it("setNodeOperatorFeeRecipient", async () => {
          await testGrantingRole(
            testDashboard,
            "setNodeOperatorFeeRecipient",
            await testDashboard.NODE_OPERATOR_FEE_RECIPIENT_SET_ROLE(),
            [stranger],
            nodeOperatorManager,
          );
        });
      });
    });
  });

  async function testMethod<T extends unknown[]>(
    dashboard: Dashboard,
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
    dashboard: Dashboard,
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
    dashboard: Dashboard,
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
