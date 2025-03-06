import { expect } from "chai";
import { ContractMethodArgs, ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation } from "typechain-types";

import { days, impersonate, randomAddress } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import { ether } from "../../../lib/units";

const VAULT_OWNER_FEE = 1_00n; // 1% AUM owner fee
const VAULT_NODE_OPERATOR_FEE = 1_00n; // 3% node operator fee

type Methods<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]: T[K] extends (...args: any) => any ? K : never; // gdfg
}[keyof T];

type DelegationMethods = Methods<Delegation>; // "foo" | "bar"

describe("Scenario: Staking Vaults Delegation Roles full init", () => {
  let ctx: ProtocolContext;

  let testDelegation: Delegation;

  let snapshot: string;
  let owner: HardhatEthersSigner,
    nodeOperatorManager: HardhatEthersSigner,
    funder: HardhatEthersSigner,
    withdrawer: HardhatEthersSigner,
    minter: HardhatEthersSigner,
    burner: HardhatEthersSigner,
    rebalancer: HardhatEthersSigner,
    depositPausers: HardhatEthersSigner,
    depositResumers: HardhatEthersSigner,
    validatorExitRequesters: HardhatEthersSigner,
    validatorWithdrawalTriggerers: HardhatEthersSigner,
    disconnecters: HardhatEthersSigner,
    curatorFeeSetters: HardhatEthersSigner,
    curatorFeeClaimers: HardhatEthersSigner,
    nodeOperatorFeeClaimers: HardhatEthersSigner,
    stranger: HardhatEthersSigner;

  let allRoles: HardhatEthersSigner[];

  before(async () => {
    ctx = await getProtocolContext();

    allRoles = await getRandomSigners(16);
    [
      owner,
      nodeOperatorManager,
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
      curatorFeeSetters,
      curatorFeeClaimers,
      nodeOperatorFeeClaimers,
      stranger,
    ] = allRoles;

    const { depositSecurityModule } = ctx.contracts;
    await depositSecurityModule.DEPOSIT_CONTRACT();

    const { stakingVaultFactory } = ctx.contracts;

    // Owner can create a vault with operator as a node operator
    const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
      {
        defaultAdmin: owner,
        nodeOperatorManager: nodeOperatorManager,
        curatorFeeBP: VAULT_OWNER_FEE,
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
        curatorFeeSetters: [curatorFeeSetters],
        curatorFeeClaimers: [curatorFeeClaimers],
        nodeOperatorFeeClaimers: [nodeOperatorFeeClaimers],
      },
      "0x",
    );

    const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    testDelegation = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);
  });

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  describe("Only roles", () => {
    describe("Delegation methods", () => {
      it("setCuratorFeeBP", async () => {
        await testMethod(
          "setCuratorFeeBP",
          {
            successUsers: [curatorFeeSetters],
            failingUsers: allRoles.filter((r) => r !== curatorFeeSetters),
          },
          [1n],
          await testDelegation.CURATOR_FEE_SET_ROLE(),
        );

        await testRevokingRole("setCuratorFeeBP", await testDelegation.CURATOR_FEE_SET_ROLE(), curatorFeeSetters, [1n]);
      });

      it("claimCuratorFee", async () => {
        await testMethod(
          "claimCuratorFee",
          {
            successUsers: [curatorFeeClaimers],
            failingUsers: allRoles.filter((r) => r !== curatorFeeClaimers),
          },
          [stranger],
          await testDelegation.CURATOR_FEE_CLAIM_ROLE(),
        );

        await testRevokingRole("claimCuratorFee", await testDelegation.CURATOR_FEE_CLAIM_ROLE(), curatorFeeClaimers, [
          stranger,
        ]);
      });

      it("claimNodeOperatorFee", async () => {
        await testMethod(
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
          "recoverERC20",
          {
            successUsers: [owner],
            failingUsers: allRoles.filter((r) => r !== owner),
          },
          [ZeroAddress, owner, 1n],
          await testDelegation.DEFAULT_ADMIN_ROLE(),
        );
      });

      it("recoverERC721", async () => {
        await testMethod(
          "recoverERC721",
          {
            successUsers: [owner],
            failingUsers: allRoles.filter((r) => r !== owner),
          },
          [ZeroAddress, 0, stranger],
          await testDelegation.DEFAULT_ADMIN_ROLE(),
        );
      });
    });
  });

  describe("only confirmed roles", () => {
    it("setNodeOperatorFeeBP", async () => {
      await testMethodConfirmedRoles(
        "setNodeOperatorFeeBP",
        {
          successUsers: [owner, nodeOperatorManager],
          failingUsers: allRoles.filter((r) => r !== owner && r !== nodeOperatorManager),
        },
        [1n],
      );
    });

    it("setConfirmExpiry", async () => {
      await testMethodConfirmedRoles(
        "setConfirmExpiry",
        {
          successUsers: [owner, nodeOperatorManager],
          failingUsers: allRoles.filter((r) => r !== owner && r !== nodeOperatorManager),
        },
        [days(7n)],
      );
    });
  });

  async function testMethod<T extends unknown[]>(
    methodName: DelegationMethods,
    { successUsers, failingUsers }: { successUsers: HardhatEthersSigner[]; failingUsers: HardhatEthersSigner[] },
    argument: T,
    requiredRole: string,
  ) {
    for (const user of failingUsers) {
      await expect(testDelegation.connect(user)[methodName](...(argument as ContractMethodArgs<T>)))
        .to.be.revertedWithCustomError(testDelegation, "AccessControlUnauthorizedAccount")
        .withArgs(user, requiredRole);
    }

    for (const user of successUsers) {
      await expect(
        testDelegation.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.not.revertedWithCustomError(testDelegation, "AccessControlUnauthorizedAccount");
    }
  }

  async function testMethodConfirmedRoles<T extends unknown[]>(
    methodName: DelegationMethods,
    { successUsers, failingUsers }: { successUsers: HardhatEthersSigner[]; failingUsers: HardhatEthersSigner[] },
    argument: T,
  ) {
    for (const user of failingUsers) {
      await expect(
        testDelegation.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.revertedWithCustomError(testDelegation, "SenderNotMember");
    }

    for (const user of successUsers) {
      await expect(
        testDelegation.connect(user)[methodName](...(argument as ContractMethodArgs<T>)),
      ).to.be.not.revertedWithCustomError(testDelegation, "SenderNotMember");
    }
  }

  async function testRevokingRole<T extends unknown[]>(
    methodName: DelegationMethods,
    roleToRevoke: string,
    userToRevoke: HardhatEthersSigner,
    argument: T,
  ) {
    await testDelegation.connect(owner).revokeRole(roleToRevoke, userToRevoke);

    await expect(
      testDelegation.connect(userToRevoke)[methodName](...(argument as ContractMethodArgs<T>)),
    ).to.be.revertedWithCustomError(testDelegation, "AccessControlUnauthorizedAccount");

    await testDelegation.connect(owner).grantRole(roleToRevoke, userToRevoke);
  }

  async function getRandomSigners(amount: number): Promise<HardhatEthersSigner[]> {
    const signers = [];
    for (let i = 0; i < amount; i++) {
      signers.push(await impersonate(randomAddress(), ether("1")));
    }
    return signers;
  }
});
