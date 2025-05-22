import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { certainAddress, ether, generatePostDeposit, generatePredeposit, generateValidator } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  setupLido,
} from "lib/protocol";
import {
  getProofAndDepositData,
  getPubkeys,
  reportVaultDataWithProof,
  VaultRoles,
} from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

describe("Integration: Actions with vault disconnected from hub", () => {
  let ctx: ProtocolContext;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let roles: VaultRoles;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    originalSnapshot = await Snapshot.take();

    ctx = await getProtocolContext();

    await setupLido(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, roles } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    await dashboard.connect(roles.disconnecter).voluntaryDisconnect();
    await reportVaultDataWithProof(ctx, stakingVault);
    // disconnect is completed when the vault is reported to the hub
    dashboard = dashboard.connect(owner);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Dashboard is owner", () => {
    it("Can transfer the StakingVault ownership further", async () => {
      const { vaultHub } = ctx.contracts;

      await expect(dashboard.abandonDashboard(stranger))
        .to.emit(stakingVault, "OwnershipTransferred")
        .withArgs(vaultHub, dashboard)
        .to.emit(stakingVault, "OwnershipTransferStarted")
        .withArgs(dashboard, stranger);

      expect(await stakingVault.pendingOwner()).to.equal(stranger);

      await expect(stakingVault.connect(stranger).acceptOwnership())
        .to.emit(stakingVault, "OwnershipTransferred")
        .withArgs(dashboard, stranger);
    });

    it("Can reconnect the vault to the hub", async () => {
      const { vaultHub } = ctx.contracts;

      await dashboard.reconnectToVaultHub();

      expect((await vaultHub.vaultConnection(stakingVault)).vaultIndex).to.not.equal(0);
    });
  });

  describe("Ownership is transferred to owner EOA", () => {
    beforeEach(async () => {
      await dashboard.abandonDashboard(owner);
      await stakingVault.connect(owner).acceptOwnership();
    });

    describe("Ownership transfer", () => {
      it("Can transfer the StakingVault ownership further", async () => {
        const newOwner = certainAddress("new-owner");

        await expect(stakingVault.connect(owner).transferOwnership(newOwner))
          .to.emit(stakingVault, "OwnershipTransferStarted")
          .withArgs(owner, newOwner);

        expect(await stakingVault.pendingOwner()).to.equal(newOwner);
      });

      it("Can reconnect the vault to the hub", async () => {
        const { vaultHub } = ctx.contracts;

        await expect(stakingVault.connect(owner).transferOwnership(vaultHub))
          .to.emit(stakingVault, "OwnershipTransferStarted")
          .withArgs(owner, vaultHub);

        await expect(vaultHub.connectVault(stakingVault))
          .to.emit(stakingVault, "OwnershipTransferred")
          .withArgs(owner, vaultHub);

        expect((await vaultHub.vaultConnection(stakingVault)).vaultIndex).to.not.equal(0);
      });

      it("Can reconnect the vault to the dashboard and then to the hub", async () => {
        await expect(stakingVault.connect(owner).transferOwnership(dashboard))
          .to.emit(stakingVault, "OwnershipTransferStarted")
          .withArgs(owner, dashboard);

        const { vaultHub } = ctx.contracts;

        await expect(dashboard.reconnectToVaultHub())
          .to.emit(stakingVault, "OwnershipTransferred")
          .withArgs(owner, dashboard)
          .to.emit(stakingVault, "OwnershipTransferStarted")
          .withArgs(dashboard, vaultHub)
          .to.emit(vaultHub, "VaultConnected");

        expect((await vaultHub.vaultConnection(stakingVault)).vaultIndex).to.not.equal(0);
      });
    });

    describe("Funding", () => {
      it("Can fund the vault", async () => {
        const amount = ether("10");
        const balance = await ethers.provider.getBalance(stakingVault);

        await expect(stakingVault.connect(owner).fund({ value: amount }))
          .to.emit(stakingVault, "EtherFunded")
          .withArgs(amount);

        expect(await ethers.provider.getBalance(stakingVault)).to.equal(balance + amount);
      });

      it("Can withdraw the funds", async () => {
        const balance = await ethers.provider.getBalance(stranger);
        const amount = await ethers.provider.getBalance(stakingVault);

        await expect(stakingVault.connect(owner).withdraw(stranger, amount))
          .to.emit(stakingVault, "EtherWithdrawn")
          .withArgs(stranger, amount);

        expect(await ethers.provider.getBalance(stranger)).to.equal(balance + amount);
      });
    });

    describe("Ossification", () => {
      it("Can ossify vault", async () => {
        await expect(stakingVault.connect(owner).ossify()).to.emit(
          stakingVault,
          "PinnedImplementationUpdated",
        );

        expect(await stakingVault.isOssified()).to.equal(true);
      });

      describe("Ossified", () => {
        beforeEach(async () => {
          await stakingVault.connect(owner).ossify();
        });

        it("Can't ossify vault again", async () => {
          await expect(stakingVault.connect(owner).ossify()).to.be.revertedWithCustomError(
            stakingVault,
            "VaultOssified",
          );
        });

        it("Can withdraw the funds", async () => {
          const balance = await ethers.provider.getBalance(stranger);
          const amount = await ethers.provider.getBalance(stakingVault);

          await expect(stakingVault.connect(owner).withdraw(stranger, amount))
            .to.emit(stakingVault, "EtherWithdrawn")
            .withArgs(stranger, amount);

          expect(await ethers.provider.getBalance(stranger)).to.equal(balance + amount);
        });

        it("Can't reconnect the vault to the hub", async () => {
          const { vaultHub } = ctx.contracts;
          await stakingVault.connect(owner).transferOwnership(vaultHub);

          await expect(vaultHub.connectVault(stakingVault))
            .to.be.revertedWithCustomError(vaultHub, "VaultOssified")
            .withArgs(stakingVault);
        });
      });
    });

    describe("Validator exiting", () => {
      it("Can request validator exit", async () => {
        const keys = getPubkeys(2);
        await expect(stakingVault.connect(owner).requestValidatorExit(keys.stringified))
          .to.emit(stakingVault, "ValidatorExitRequested")
          .withArgs(keys.pubkeys[0], keys.pubkeys[0])
          .to.emit(stakingVault, "ValidatorExitRequested")
          .withArgs(keys.pubkeys[1], keys.pubkeys[1]);
      });

      it("Can trigger validator withdrawal", async () => {
        const keys = getPubkeys(2);
        const value = await stakingVault.calculateValidatorWithdrawalFee(2);
        await expect(stakingVault.connect(owner).triggerValidatorWithdrawals(keys.stringified, [ether("1"), ether("2")], owner.address, { value }))
          .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
          .withArgs(keys.stringified, [ether("1"), ether("2")], 0, owner.address);
      });
    });

    describe("Deposits", () => {
      beforeEach(async () => {
        await stakingVault.connect(owner).fund({ value: ether("2048") });
      });

      it("Can set depositor and deposit validators to beacon chain", async () => {
        const { predepositGuarantee } = ctx.contracts;
        await expect(stakingVault.connect(owner).setDepositor(owner))
          .to.emit(stakingVault, "DepositorSet")
          .withArgs(predepositGuarantee, owner);

        expect(await stakingVault.depositor()).to.equal(owner);

        const withdrawalCredentials = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(withdrawalCredentials);

        const deposit = await generatePostDeposit(validator.container, ether("2048"));

        await expect(stakingVault.connect(owner).depositToBeaconChain([deposit])).to.emit(
          stakingVault,
          "DepositedToBeaconChain",
        );
      });

      it("Can pause/resume deposits to beacon chain", async () => {
        await expect(stakingVault.connect(owner).pauseBeaconChainDeposits())
          .to.emit(stakingVault, "BeaconChainDepositsPaused");

        await expect(stakingVault.connect(owner).resumeBeaconChainDeposits())
          .to.emit(stakingVault, "BeaconChainDepositsResumed");
      });

      it("Can deposit to beacon chain using predeposit guarantee", async () => {
        const { predepositGuarantee } = ctx.contracts;
        const withdrawalCredentials = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(withdrawalCredentials);

        await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, {
          value: ether("1"),
        });

        const predepositData = await generatePredeposit(validator, {
          depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
        });

        await expect(predepositGuarantee.connect(nodeOperator).predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]))
          .to.emit(stakingVault, "DepositedToBeaconChain")
          .withArgs(1, ether("1"));

        const { witnesses, postdeposit } = await getProofAndDepositData(
          predepositGuarantee,
          validator,
          withdrawalCredentials,
          ether("2048"),
        );

        await expect(predepositGuarantee.connect(nodeOperator).proveAndDeposit(witnesses, [postdeposit], stakingVault))
          .to.emit(stakingVault, "DepositedToBeaconChain")
          .withArgs(1, ether("2048"));
      });
    });
  });
});
