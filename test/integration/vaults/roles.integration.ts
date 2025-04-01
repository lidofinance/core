import { expect } from "chai";
import { ContractMethodArgs, ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation } from "typechain-types";

import { days } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { getRandomSigners } from "lib/protocol/helpers/get-random-signers";

import { Snapshot } from "test/suite";

import { ether } from "../../../lib/units";

const VAULT_NODE_OPERATOR_FEE = 1_00n; // 3% node operator fee

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

type Methods<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]: T[K] extends (...args: any) => any ? K : never; // gdfg
}[keyof T];

type DelegationMethods = Methods<Delegation>; // "foo" | "bar"

describe("Integration: Staking Vaults Delegation Roles Initial Setup", () => {
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
    depositPausers: HardhatEthersSigner,
    depositResumers: HardhatEthersSigner,
    validatorExitRequesters: HardhatEthersSigner,
    validatorWithdrawalTriggerers: HardhatEthersSigner,
    disconnecters: HardhatEthersSigner,
    nodeOperatorFeeClaimers: HardhatEthersSigner,
    stranger: HardhatEthersSigner,
    nodeOperatorRewardAdjusters: HardhatEthersSigner,
    trustedWithdrawDepositors: HardhatEthersSigner,
    unknownValidatorProvers: HardhatEthersSigner,
    pdgCompensators: HardhatEthersSigner;

  let allRoles: HardhatEthersSigner[];

  before(async () => {
    ctx = await getProtocolContext();

    allRoles = await getRandomSigners(30);
    [
      owner,
      nodeOperatorManager,
      assetRecoverer,
      funder,
      withdrawer,
      minter,
      burner,
      rebalancer,
      depositPausers,
      depositResumers,
      validatorExitRequesters,
      validatorWithdrawalTriggerers,
      disconnecters,
      nodeOperatorFeeClaimers,
      stranger,
      nodeOperatorRewardAdjusters,
      trustedWithdrawDepositors,
      unknownValidatorProvers,
      pdgCompensators,
    ] = allRoles;

    const { depositSecurityModule } = ctx.contracts;
    await depositSecurityModule.DEPOSIT_CONTRACT();
  });

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  // initializing contracts with signers
  describe("Vault created with all the roles", () => {
    let testDelegation: Delegation;

    before(async () => {
      const { stakingVaultFactory } = ctx.contracts;

      // Owner can create a vault with operator as a node operator
      const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
        {
          defaultAdmin: owner,
          nodeOperatorManager: nodeOperatorManager,
          assetRecoverer: assetRecoverer,
          nodeOperatorFeeBP: VAULT_NODE_OPERATOR_FEE,
          confirmExpiry: days(7n),
          funders: [funder],
          withdrawers: [withdrawer],
          minters: [minter],
          burners: [burner],
          rebalancers: [rebalancer],
          depositPausers: [depositPausers],
          depositResumers: [depositResumers],
          validatorExitRequesters: [validatorExitRequesters],
          validatorWithdrawalTriggerers: [validatorWithdrawalTriggerers],
          disconnecters: [disconnecters],
          nodeOperatorFeeClaimers: [nodeOperatorFeeClaimers],
          nodeOperatorRewardAdjusters: [nodeOperatorRewardAdjusters],
          trustedWithdrawDepositors: [trustedWithdrawDepositors],
          unknownValidatorProvers: [unknownValidatorProvers],
          pdgCompensators: [pdgCompensators],
        },
        "0x",
      );

      const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
      const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

      testDelegation = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);
    });

    describe("Verify ACL for methods that require only role", () => {
      describe("Delegation methods", () => {
        it("claimNodeOperatorFee", async () => {
          await testMethod(
            testDelegation,
            "claimNodeOperatorFee",
            {
              successUsers: [nodeOperatorFeeClaimers],
              failingUsers: allRoles.filter((r) => r !== nodeOperatorFeeClaimers),
            },
            [stranger],
            await testDelegation.NODE_OPERATOR_FEE_CLAIM_ROLE(),
          );
        });
      });

      describe("Dashboard methods", () => {
        it("recoverERC20", async () => {
          await testMethod(
            testDelegation,
            "recoverERC20",
            {
              successUsers: [assetRecoverer],
              failingUsers: allRoles.filter((r) => r !== assetRecoverer),
            },
            [ZeroAddress, owner, 1n],
            await testDelegation.ASSET_RECOVERY_ROLE(),
          );
        });

        it("recoverERC721", async () => {
          await testMethod(
            testDelegation,
            "recoverERC721",
            {
              successUsers: [assetRecoverer],
              failingUsers: allRoles.filter((r) => r !== assetRecoverer),
            },
            [ZeroAddress, 0, stranger],
            await testDelegation.ASSET_RECOVERY_ROLE(),
          );
        });

        it("triggerValidatorWithdrawal", async () => {
          await testMethod(
            testDelegation,
            "triggerValidatorWithdrawal",
            {
              successUsers: [validatorWithdrawalTriggerers],
              failingUsers: allRoles.filter((r) => r !== validatorWithdrawalTriggerers),
            },
            ["0x", [0n], stranger],
            await testDelegation.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
          );
        });

        it("requestValidatorExit", async () => {
          await testMethod(
            testDelegation,
            "requestValidatorExit",
            {
              successUsers: [validatorExitRequesters],
              failingUsers: allRoles.filter((r) => r !== validatorExitRequesters),
            },
            ["0x" + "ab".repeat(48)],
            await testDelegation.REQUEST_VALIDATOR_EXIT_ROLE(),
          );
        });

        it("resumeBeaconChainDeposits", async () => {
          await testMethod(
            testDelegation,
            "resumeBeaconChainDeposits",
            {
              successUsers: [depositResumers],
              failingUsers: allRoles.filter((r) => r !== depositResumers),
            },
            [],
            await testDelegation.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
          );
        });

        it("pauseBeaconChainDeposits", async () => {
          await testMethod(
            testDelegation,
            "pauseBeaconChainDeposits",
            {
              successUsers: [depositPausers],
              failingUsers: allRoles.filter((r) => r !== depositPausers),
            },
            [],
            await testDelegation.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("compensateDisprovenPredepositFromPDG", async () => {
          await testMethod(
            testDelegation,
            "compensateDisprovenPredepositFromPDG",
            {
              successUsers: [pdgCompensators],
              failingUsers: allRoles.filter((r) => r !== pdgCompensators),
            },
            [SAMPLE_PUBKEY, stranger],
            await testDelegation.PDG_COMPENSATE_PREDEPOSIT_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("proveUnknownValidatorsToPDG", async () => {
          await testMethod(
            testDelegation,
            "proveUnknownValidatorsToPDG",
            {
              successUsers: [unknownValidatorProvers],
              failingUsers: allRoles.filter((r) => r !== unknownValidatorProvers),
            },
            [SAMPLE_PUBKEY, stranger],
            await testDelegation.PDG_PROVE_VALIDATOR_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("increaseAccruedRewardsAdjustment", async () => {
          await testMethod(
            testDelegation,
            "increaseAccruedRewardsAdjustment",
            {
              successUsers: [nodeOperatorRewardAdjusters],
              failingUsers: allRoles.filter((r) => r !== nodeOperatorRewardAdjusters),
            },
            [SAMPLE_PUBKEY, stranger],
            await testDelegation.NODE_OPERATOR_REWARDS_ADJUST_ROLE(),
          );
        });

        it("rebalanceVault", async () => {
          await testMethod(
            testDelegation,
            "rebalanceVault",
            {
              successUsers: [rebalancer],
              failingUsers: allRoles.filter((r) => r !== rebalancer),
            },
            [1n],
            await testDelegation.REBALANCE_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("burnWstETHWithPermit", async () => {
          await testMethod(
            testDelegation,
            "burnWstETHWithPermit",
            {
              successUsers: [burner],
              failingUsers: allRoles.filter((r) => r !== burner),
            },
            [ZeroAddress, 0, stranger],
            await testDelegation.BURN_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("burnStETHWithPermit", async () => {
          await testMethod(
            testDelegation,
            "burnStETHWithPermit",
            {
              successUsers: [burner],
              failingUsers: allRoles.filter((r) => r !== burner),
            },
            [ZeroAddress, 0, stranger],
            await testDelegation.BURN_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("burnSharesWithPermit", async () => {
          await testMethod(
            testDelegation,
            "burnSharesWithPermit",
            {
              successUsers: [burner],
              failingUsers: allRoles.filter((r) => r !== burner),
            },
            [stranger],
            await testDelegation.BURN_ROLE(),
          );
        });

        it("mintWstETH", async () => {
          await testMethod(
            testDelegation,
            "mintWstETH",
            {
              successUsers: [minter],
              failingUsers: allRoles.filter((r) => r !== minter),
            },
            [ZeroAddress, 0, stranger],
            await testDelegation.MINT_ROLE(),
          );
        });
        it("mintStETH", async () => {
          await testMethod(
            testDelegation,
            "mintStETH",
            {
              successUsers: [minter],
              failingUsers: allRoles.filter((r) => r !== minter),
            },
            [stranger, 1n],
            await testDelegation.MINT_ROLE(),
          );
        });

        it("mintShares", async () => {
          await testMethod(
            testDelegation,
            "mintShares",
            {
              successUsers: [minter],
              failingUsers: allRoles.filter((r) => r !== minter),
            },
            [stranger, 100n],
            await testDelegation.MINT_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it("withdraw", async () => {
          await testDelegation.connect(funder).fund({ value: 1n });
          await testMethod(
            testDelegation,
            "withdraw",
            {
              successUsers: [withdrawer],
              failingUsers: allRoles.filter((r) => r !== withdrawer),
            },
            [stranger, 1n],
            await testDelegation.WITHDRAW_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("withdrawWETH", async () => {
          await testMethod(
            testDelegation,
            "withdrawWETH",
            {
              successUsers: [withdrawer],
              failingUsers: allRoles.filter((r) => r !== withdrawer),
            },
            [stranger, ether("1")],
            await testDelegation.WITHDRAW_ROLE(),
          );
        });

        // requires prepared state for this test to pass, skipping for now
        it.skip("fundWeth", async () => {
          await testMethod(
            testDelegation,
            "fundWeth",
            {
              successUsers: [funder],
              failingUsers: allRoles.filter((r) => r !== funder),
            },
            [ether("1"), { from: funder.address }],
            await testDelegation.FUND_ROLE(),
          );
        });
        it("fund", async () => {
          await testMethod(
            testDelegation,
            "fund",
            {
              successUsers: [funder],
              failingUsers: allRoles.filter((r) => r !== funder),
            },
            [{ value: 1n }],
            await testDelegation.FUND_ROLE(),
          );
        });
        //burnWstETH, burnStETH,burnShares
      });
    });

    describe("Verify ACL for methods that require confirmations", () => {
      it("setNodeOperatorFeeBP", async () => {
        await expect(testDelegation.connect(owner).setNodeOperatorFeeBP(1n)).not.to.emit(
          testDelegation,
          "NodeOperatorFeeBPSet",
        );
        await expect(testDelegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(1n)).to.emit(
          testDelegation,
          "NodeOperatorFeeBPSet",
        );

        await testMethodConfirmedRoles(
          testDelegation,
          "setNodeOperatorFeeBP",
          {
            successUsers: [],
            failingUsers: allRoles.filter((r) => r !== owner && r !== nodeOperatorManager),
          },
          [1n],
        );
      });

      it("setConfirmExpiry", async () => {
        await expect(testDelegation.connect(owner).setConfirmExpiry(days(7n))).not.to.emit(
          testDelegation,
          "ConfirmExpirySet",
        );
        await expect(testDelegation.connect(nodeOperatorManager).setConfirmExpiry(days(7n))).to.emit(
          testDelegation,
          "ConfirmExpirySet",
        );

        await testMethodConfirmedRoles(
          testDelegation,
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
      expect(await testDelegation.connect(funder).unreserved()).to.equal(0);
      expect(await testDelegation.connect(funder).nodeOperatorUnclaimedFee()).to.equal(0);
      expect(await testDelegation.connect(funder).withdrawableEther()).to.equal(0);
    });

    it("Allows to retrieve roles addresses", async () => {
      expect(await testDelegation.getRoleMembers(await testDelegation.MINT_ROLE())).to.deep.equal([minter.address]);
    });
  });

  // initializing contracts without signers
  describe('"Vault created with no roles', () => {
    let testDelegation: Delegation;

    before(async () => {
      const { stakingVaultFactory } = ctx.contracts;
      allRoles = await getRandomSigners(2);
      [owner, stranger] = allRoles;
      // Owner can create a vault with operator as a node operator
      const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
        {
          defaultAdmin: owner,
          nodeOperatorManager: nodeOperatorManager,
          nodeOperatorFeeBP: VAULT_NODE_OPERATOR_FEE,
          assetRecoverer: assetRecoverer,
          confirmExpiry: days(7n),
          funders: [],
          withdrawers: [],
          minters: [],
          burners: [],
          rebalancers: [],
          depositPausers: [],
          depositResumers: [],
          validatorExitRequesters: [],
          validatorWithdrawalTriggerers: [],
          disconnecters: [],
          nodeOperatorFeeClaimers: [],
          nodeOperatorRewardAdjusters: [],
          trustedWithdrawDepositors: [],
          pdgCompensators: [],
          unknownValidatorProvers: [],
        },
        "0x",
      );

      const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
      const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

      testDelegation = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);
    });

    it("Verify that roles are not assigned", async () => {
      const roles = await Promise.all([
        testDelegation.NODE_OPERATOR_FEE_CLAIM_ROLE(),
        testDelegation.FUND_ROLE(),
        testDelegation.WITHDRAW_ROLE(),
        testDelegation.MINT_ROLE(),
        testDelegation.BURN_ROLE(),
        testDelegation.REBALANCE_ROLE(),
        testDelegation.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
        testDelegation.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
        testDelegation.REQUEST_VALIDATOR_EXIT_ROLE(),
        testDelegation.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
        testDelegation.VOLUNTARY_DISCONNECT_ROLE(),
        testDelegation.NODE_OPERATOR_REWARDS_ADJUST_ROLE(),
        testDelegation.TRUSTED_WITHDRAW_DEPOSIT_ROLE(),
        testDelegation.PDG_PROVE_VALIDATOR_ROLE(),
        testDelegation.PDG_COMPENSATE_PREDEPOSIT_ROLE(),
      ]);

      for (const role of roles) {
        expect(await testDelegation.getRoleMembers(role)).to.deep.equal([]);
      }
    });
    describe("Verify ACL for methods that require only role", () => {
      describe("Delegation methods", () => {
        it("claimNodeOperatorFee", async () => {
          await testGrantingRole(
            testDelegation,
            "claimNodeOperatorFee",
            await testDelegation.NODE_OPERATOR_FEE_CLAIM_ROLE(),
            [stranger],
            nodeOperatorManager,
          );
        });
      });
    });
  });

  async function testMethod<T extends unknown[]>(
    delegation: Delegation,
    methodName: DelegationMethods,
    { successUsers, failingUsers }: { successUsers: HardhatEthersSigner[]; failingUsers: HardhatEthersSigner[] },
    argument: T,
    requiredRole: string,
  ) {
    for (const user of failingUsers) {
      await expect(delegation.connect(user)[methodName](...(argument as ContractMethodArgs<T>)))
        .to.be.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount")
        .withArgs(user, requiredRole);
    }

    for (const user of successUsers) {
      await expect(
        delegation.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.not.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount");
    }
  }

  async function testMethodConfirmedRoles<T extends unknown[]>(
    delegation: Delegation,
    methodName: DelegationMethods,
    { successUsers, failingUsers }: { successUsers: HardhatEthersSigner[]; failingUsers: HardhatEthersSigner[] },
    argument: T,
  ) {
    for (const user of failingUsers) {
      await expect(
        delegation.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.revertedWithCustomError(delegation, "SenderNotMember");
    }

    for (const user of successUsers) {
      await expect(
        delegation.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.not.revertedWithCustomError(delegation, "SenderNotMember");
    }
  }

  async function testGrantingRole<T extends unknown[]>(
    delegation: Delegation,
    methodName: DelegationMethods,
    roleToGrant: string,
    argument: T,
    roleGratingActor: HardhatEthersSigner,
  ) {
    await expect(
      delegation.connect(stranger)[methodName](...(argument as ContractMethodArgs<T>)),
    ).to.be.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount");

    await delegation.connect(roleGratingActor).grantRole(roleToGrant, stranger);

    await expect(
      delegation.connect(stranger)[methodName](...(argument as ContractMethodArgs<T>)),
    ).to.not.be.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount");

    await delegation.connect(roleGratingActor).revokeRole(roleToGrant, stranger);
  }
});
