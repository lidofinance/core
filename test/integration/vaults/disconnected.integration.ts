import { expect } from "chai";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, DepositContract, StakingVault } from "typechain-types";

import {
  addressToWC,
  certainAddress,
  ether,
  generateDepositStruct,
  generatePredeposit,
  generateValidator,
  getNextBlockTimestamp,
  impersonate,
  MAX_SANE_SETTLED_GROWTH,
  toGwei,
  toLittleEndian64,
  ValidatorStage,
} from "lib";
import {
  createVaultWithDashboard,
  ensurePredepositGuaranteeUnpaused,
  getProtocolContext,
  getPubkeys,
  mockProof,
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

      it("Cannot renounce ownership", async () => {
        await expect(stakingVault.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(
          stakingVault,
          "RenouncementNotAllowed",
        );
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

      const tierId = (await operatorGrid.group(nodeOperator)).tierIds[0];

      await expect(operatorGrid.connect(owner).changeTier(stakingVault, tierId, 1000n)).to.be.revertedWithCustomError(
        operatorGrid,
        "VaultNotConnected",
      );

      const nodeOperatorRoleAsAddress = ethers.zeroPadValue(nodeOperator.address, 32);
      const msgData = operatorGrid.interface.encodeFunctionData("changeTier", [
        await stakingVault.getAddress(),
        tierId,
        1000n,
      ]);
      const confirmTimestamp = await getNextBlockTimestamp();
      const expiryTimestamp = confirmTimestamp + (await operatorGrid.getConfirmExpiry());

      await expect(operatorGrid.connect(nodeOperator).changeTier(stakingVault, tierId, 1000n))
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

        const tx = stakingVault
          .connect(owner)
          .triggerValidatorWithdrawals(keys.stringified, [], owner, { value: value * 2n });
        await expect(tx).to.changeEtherBalance(owner, -value);
        await expect(tx)
          .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
          .withArgs(keys.stringified, [], value, owner);
      });

      it("Node operator can eject validators", async () => {
        const keys = getPubkeys(2);
        const value = await stakingVault.calculateValidatorWithdrawalFee(2);
        const tx = stakingVault
          .connect(nodeOperator)
          .ejectValidators(keys.stringified, nodeOperator, { value: value * 2n });
        await expect(tx).to.changeEtherBalance(nodeOperator, -value);
        await expect(tx)
          .to.emit(stakingVault, "ValidatorEjectionsTriggered")
          .withArgs(keys.stringified, value, nodeOperator);
      });
    });

    describe("Deposits", () => {
      before(async () => {
        await ensurePredepositGuaranteeUnpaused(ctx);
      });

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

      it("Can deposit to beacon chain using PDG", async () => {
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

        const witness = await mockProof(ctx, validator);

        await expect(
          predepositGuarantee.connect(nodeOperator).proveWCActivateAndTopUpValidators([witness], [ether("2016")]),
        )
          .to.emit(predepositGuarantee, "ValidatorProven")
          .withArgs(witness.pubkey, nodeOperator, await stakingVault.getAddress(), withdrawalCredentials)
          .to.emit(depositContract, "DepositEvent")
          .withArgs(witness.pubkey, withdrawalCredentials, toLittleEndian64(toGwei(ether("2047"))), anyValue, anyValue);
      });

      it("Can deposit to beacon chain using PDG even if messing with staged balance", async () => {
        const { predepositGuarantee, vaultHub } = ctx.contracts;
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
        ).to.emit(depositContract, "DepositEvent");

        await stakingVault.connect(await impersonate(await stakingVault.depositor())).unstage(ether("1"));

        const witness = await mockProof(ctx, validator);
        await expect(predepositGuarantee.connect(nodeOperator).proveWCAndActivate(witness))
          .to.emit(predepositGuarantee, "ValidatorProven")
          .withArgs(witness.pubkey, nodeOperator, stakingVault, withdrawalCredentials)
          .not.to.emit(depositContract, "DepositEvent")
          .not.to.emit(stakingVault, "EtherUnstaged");

        const validatorStatus = await predepositGuarantee.validatorStatus(validator.container.pubkey);
        expect(validatorStatus.stage).to.equal(ValidatorStage.PROVEN);
        expect(validatorStatus.stakingVault).to.equal(stakingVault);
        expect(validatorStatus.nodeOperator).to.equal(nodeOperator);

        expect(await predepositGuarantee.pendingActivations(stakingVault)).to.equal(1);

        await expect(stakingVault.connect(owner).transferOwnership(vaultHub))
          .to.emit(stakingVault, "OwnershipTransferStarted")
          .withArgs(owner, vaultHub);

        await expect(vaultHub.connectVault(stakingVault)).to.be.revertedWithCustomError(
          vaultHub,
          "InsufficientStagedBalance",
        );

        await stakingVault.connect(await impersonate(await stakingVault.depositor())).stage(ether("1"));

        await expect(vaultHub.connectVault(stakingVault))
          .to.emit(stakingVault, "OwnershipTransferred")
          .withArgs(owner, vaultHub);

        expect(await vaultHub.isVaultConnected(stakingVault)).to.equal(true);

        await expect(predepositGuarantee.connect(stranger).activateValidator(validator.container.pubkey))
          .to.emit(predepositGuarantee, "ValidatorActivated")
          .withArgs(validator.container.pubkey, nodeOperator, stakingVault, withdrawalCredentials);
      });

      it("Can receive compensation for disproven predeposit even if messing with staged balance", async () => {
        const { predepositGuarantee } = ctx.contracts;

        await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, {
          value: ether("1"),
        });

        const invalidWithdrawalCredentials = addressToWC(nodeOperator.address);
        const invalidValidator = generateValidator(invalidWithdrawalCredentials);

        const invalidValidatorHackedWC = {
          ...invalidValidator,
          container: {
            ...invalidValidator.container,
            withdrawalCredentials: await stakingVault.withdrawalCredentials(),
          },
        };

        const predepositData = await generatePredeposit(invalidValidatorHackedWC, {
          depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
        });

        await expect(
          predepositGuarantee
            .connect(nodeOperator)
            .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
        ).to.emit(depositContract, "DepositEvent");

        await stakingVault.connect(await impersonate(predepositGuarantee, ether("10"))).unstage(ether("1"));

        const witness = await mockProof(ctx, invalidValidator);
        expect(await predepositGuarantee.pendingActivations(stakingVault)).to.equal(1);
        await expect(
          predepositGuarantee.connect(stranger).proveInvalidValidatorWC(witness, invalidWithdrawalCredentials),
        )
          .to.emit(predepositGuarantee, "ValidatorCompensated")
          .withArgs(stakingVault, nodeOperator, invalidValidator.container.pubkey, ether("0"), ether("0"))
          .not.to.emit(stakingVault, "EtherUnstaged");
      });
    });

    describe("Ossification", () => {
      beforeEach(async () => {
        await expect(stakingVault.connect(owner).ossify()).to.emit(stakingVault, "PinnedImplementationUpdated");
      });

      it("isOssified() returns true", async () => {
        const pinnedBeaconProxy = await ethers.getContractAt("PinnedBeaconProxy", stakingVault);
        expect(await pinnedBeaconProxy.isOssified()).to.be.true;
      });

      it("implementation() returns the ossified implementation", async () => {
        const { stakingVaultBeacon } = ctx.contracts;
        const pinnedBeaconProxy = await ethers.getContractAt("PinnedBeaconProxy", stakingVault);
        expect(await pinnedBeaconProxy.implementation()).to.equal(await stakingVaultBeacon.implementation());
      });

      it("Ossified vault cannot be connected to the hub", async () => {
        const { vaultHub } = ctx.contracts;

        await expect(stakingVault.connect(owner).transferOwnership(vaultHub))
          .to.emit(stakingVault, "OwnershipTransferStarted")
          .withArgs(owner, vaultHub);

        await expect(vaultHub.connect(owner).connectVault(stakingVault)).to.be.revertedWithCustomError(
          vaultHub,
          "VaultOssified",
        );
      });

      it("Cannot ossify the vault again", async () => {
        await expect(stakingVault.connect(owner).ossify()).to.be.revertedWithCustomError(
          stakingVault,
          "AlreadyOssified",
        );
      });

      it("Ossified vault does not upgrade to a new implementation", async () => {
        const { stakingVaultBeacon, vaultHub } = ctx.contracts;

        const pinnedImplementation = await stakingVaultBeacon.implementation();

        const beaconOwner = await impersonate(await stakingVaultBeacon.owner());
        await stakingVaultBeacon.connect(beaconOwner).upgradeTo(vaultHub);

        const pinnedBeaconProxy = await ethers.getContractAt("PinnedBeaconProxy", stakingVault);
        expect(await pinnedBeaconProxy.implementation()).to.equal(pinnedImplementation);
        expect(await stakingVaultBeacon.implementation()).to.equal(vaultHub);
      });
    });
  });
});
