import { expect } from "chai";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, DepositContract, StakingVault } from "typechain-types";

import {
  certainAddress,
  ether,
  generateDepositStruct,
  generatePredeposit,
  generateValidator,
  getNextBlockTimestamp,
  MAX_SANE_SETTLED_GROWTH,
  toGwei,
  toLittleEndian64,
} from "lib";
import {
  createVaultWithDashboard,
  getProofAndDepositData,
  getProtocolContext,
  getPubkeys,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Actions with vault disconnected from hub", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let depositContract: DepositContract;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    await dashboard.connect(owner).voluntaryDisconnect();
    // disconnect is completed when the vault is reported to the hub
    await reportVaultDataWithProof(ctx, stakingVault);

    dashboard = dashboard.connect(owner);

    depositContract = await ethers.getContractAt("DepositContract", await stakingVault.DEPOSIT_CONTRACT());
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  async function correctSettledGrowth(settledGrowth = 0n) {
    await dashboard.connect(owner).correctSettledGrowth(settledGrowth, MAX_SANE_SETTLED_GROWTH);
    await dashboard.connect(nodeOperator).correctSettledGrowth(settledGrowth, MAX_SANE_SETTLED_GROWTH);
  }

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

      await correctSettledGrowth(0n);
      expect(await dashboard.settledGrowth()).to.equal(0n);

      await dashboard.reconnectToVaultHub();

      expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(true);
    });

    it("Reverts if settled growth is not corrected", async () => {
      await expect(dashboard.reconnectToVaultHub()).to.be.revertedWithCustomError(dashboard, "SettleGrowthIsNotSet");
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

        expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(true);
      });

      it("Can reconnect the vault to the dashboard and then to the hub", async () => {
        await expect(stakingVault.connect(owner).transferOwnership(dashboard))
          .to.emit(stakingVault, "OwnershipTransferStarted")
          .withArgs(owner, dashboard);

        const { vaultHub } = ctx.contracts;

        await correctSettledGrowth(0n);
        expect(await dashboard.settledGrowth()).to.equal(0n);

        await expect(dashboard.reconnectToVaultHub()) // reconnect with disabled fee accrual
          .to.emit(stakingVault, "OwnershipTransferred")
          .withArgs(owner, dashboard)
          .to.emit(stakingVault, "OwnershipTransferStarted")
          .withArgs(dashboard, vaultHub)
          .to.emit(vaultHub, "VaultConnected");

        expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(true);
      });
    });

    it("Can not change the tier as owner of the vault", async () => {
      const { operatorGrid } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, 1000);
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: 1000,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await expect(operatorGrid.connect(owner).changeTier(stakingVault, 1n, 1000n)).to.be.revertedWithCustomError(
        operatorGrid,
        "VaultNotConnected",
      );

      const nodeOperatorRoleAsAddress = ethers.zeroPadValue(nodeOperator.address, 32);
      const msgData = operatorGrid.interface.encodeFunctionData("changeTier", [
        await stakingVault.getAddress(),
        1n,
        1000n,
      ]);
      const confirmTimestamp = await getNextBlockTimestamp();
      const expiryTimestamp = confirmTimestamp + (await operatorGrid.getConfirmExpiry());

      await expect(operatorGrid.connect(nodeOperator).changeTier(stakingVault, 1n, 1000n))
        .to.emit(operatorGrid, "RoleMemberConfirmed")
        .withArgs(nodeOperator, nodeOperatorRoleAsAddress, confirmTimestamp, expiryTimestamp, msgData);
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
        await expect(
          stakingVault
            .connect(owner)
            .triggerValidatorWithdrawals(keys.stringified, [ether("1"), ether("2")], owner.address, { value }),
        )
          .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
          .withArgs(keys.stringified, [ether("1"), ether("2")], 0, owner.address);
      });
    });

    describe("Deposits", () => {
      beforeEach(async () => {
        await stakingVault.connect(owner).fund({ value: ether("2048") });
      });

      it("Can set depositor and deposit validators to beacon chain manually", async () => {
        const { predepositGuarantee } = ctx.contracts;
        await expect(stakingVault.connect(owner).setDepositor(owner))
          .to.emit(stakingVault, "DepositorSet")
          .withArgs(predepositGuarantee, owner);

        expect(await stakingVault.depositor()).to.equal(owner);

        const withdrawalCredentials = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(withdrawalCredentials);

        const deposit = generateDepositStruct(validator.container, ether("2048"));

        await expect(stakingVault.connect(owner).depositToBeaconChain(deposit))
          .to.emit(depositContract, "DepositEvent")
          .withArgs(
            deposit.pubkey,
            withdrawalCredentials,
            toLittleEndian64(toGwei(deposit.amount)),
            deposit.signature,
            anyValue,
          );
      });

      it("Can pause/resume deposits to beacon chain", async () => {
        await expect(stakingVault.connect(owner).pauseBeaconChainDeposits()).to.emit(
          stakingVault,
          "BeaconChainDepositsPaused",
        );

        await expect(stakingVault.connect(owner).resumeBeaconChainDeposits()).to.emit(
          stakingVault,
          "BeaconChainDepositsResumed",
        );
      });

      it("Can deposit to beacon chain using predeposit guarantee", async () => {
        const { predepositGuarantee } = ctx.contracts;
        const withdrawalCredentials = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(withdrawalCredentials, true);

        await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, {
          value: ether("1"),
        });

        const predepositData = await generatePredeposit(validator, {
          depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
        });

        await expect(
          predepositGuarantee
            .connect(nodeOperator)
            .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
        )
          .to.emit(depositContract, "DepositEvent")
          .withArgs(
            predepositData.deposit.pubkey,
            withdrawalCredentials,
            toLittleEndian64(toGwei(predepositData.deposit.amount)),
            predepositData.deposit.signature,
            anyValue,
          );

        const { witnesses, postdeposit } = await getProofAndDepositData(
          ctx,
          validator,
          withdrawalCredentials,
          ether("2016"),
        );

        await expect(
          predepositGuarantee.connect(nodeOperator).proveWCActivateAndTopUpValidators(witnesses, [postdeposit.amount]),
        )
          .to.emit(predepositGuarantee, "ValidatorProven")
          .withArgs(witnesses[0].pubkey, nodeOperator, await stakingVault.getAddress(), withdrawalCredentials)
          .to.emit(depositContract, "DepositEvent")
          .withArgs(
            postdeposit.pubkey,
            withdrawalCredentials,
            toLittleEndian64(toGwei(ether("2047"))),
            anyValue,
            anyValue,
          );
      });
    });
  });
});
