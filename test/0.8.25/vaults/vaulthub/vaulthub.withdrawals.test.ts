import { expect } from "chai";
import { ContractTransactionReceipt, keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { DepositContract, StakingVault, StETH__HarnessForVaultHub, VaultHub } from "typechain-types";

import { advanceChainTime, getCurrentBlockTimestamp, impersonate } from "lib";
import { findEvents } from "lib/event";
import { ether } from "lib/units";

import { deployLidoLocator, deployWithdrawalsPreDeployedMock } from "test/deploy";
import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "01".repeat(48);

const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

const FORCE_WITHDRAWAL_TIMELOCK = BigInt(3 * 24 * 60 * 60);

const FEE = 2n;

describe("VaultHub.sol:withdrawals", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let vaultHub: VaultHub;
  let vault: StakingVault;
  let steth: StETH__HarnessForVaultHub;
  let depositContract: DepositContract;

  let vaultAddress: string;
  let vaultHubAddress: string;

  let vaultSigner: HardhatEthersSigner;
  let vaultHubSigner: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [deployer, user, stranger] = await ethers.getSigners();

    await deployWithdrawalsPreDeployedMock(FEE);

    const locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [user], { value: ether("100.0") });
    depositContract = await ethers.deployContract("DepositContract");

    const vaultHubImpl = await ethers.deployContract("Accounting", [locator, steth]);
    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const accounting = await ethers.getContractAt("Accounting", proxy);
    await accounting.initialize(deployer);

    vaultHub = await ethers.getContractAt("Accounting", proxy, user);
    vaultHubAddress = await vaultHub.getAddress();

    await accounting.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await accounting.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    const stakingVaultImpl = await ethers.deployContract("StakingVault", [
      await vaultHub.getAddress(),
      await depositContract.getAddress(),
    ]);

    const vaultFactory = await ethers.deployContract("VaultFactory__Mock", [await stakingVaultImpl.getAddress()]);

    const vaultCreationTx = (await vaultFactory
      .createVault(await user.getAddress(), await user.getAddress())
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    vault = await ethers.getContractAt("StakingVault", vaultCreatedEvent.args.vault, user);
    vaultAddress = await vault.getAddress();

    const codehash = keccak256(await ethers.provider.getCode(vaultAddress));
    await vaultHub.connect(user).addVaultProxyCodehash(codehash);

    await vaultHub
      .connect(user)
      .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);

    vaultHubSigner = await impersonate(vaultHubAddress, ether("100"));
    vaultSigner = await impersonate(vaultAddress, ether("100"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  // Simulate getting in the unbalanced state
  const makeVaultUnbalanced = async () => {
    await vault.fund({ value: ether("1") });
    await vault.connect(vaultHubSigner).report(ether("1"), ether("1"), ether("1"));
    await vaultHub.mintSharesBackedByVault(vaultAddress, user, ether("0.9"));
    await vault.connect(vaultHubSigner).report(ether("1"), ether("1"), ether("1.1"));
    await vault.connect(vaultHubSigner).report(ether("0.9"), ether("1"), ether("1.1")); // slashing
  };

  // Simulate getting in the unbalanced state and reporting it
  const reportUnbalancedVault = async (): Promise<bigint> => {
    await makeVaultUnbalanced();

    const tx = await vaultHub.connect(vaultSigner).rebalance({ value: 1n });
    const events = await findEvents((await tx.wait()) as ContractTransactionReceipt, "VaultBecameUnbalanced");

    return events[0].args.unlockTime;
  };

  context("canForceValidatorWithdrawal", () => {
    it("reverts if the vault is not connected to the hub", async () => {
      await expect(vaultHub.canForceValidatorWithdrawal(stranger)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });

    it("reverts if called on a disconnected vault", async () => {
      await vaultHub.connect(user).disconnect(vaultAddress);

      await expect(vaultHub.canForceValidatorWithdrawal(stranger)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });

    it("returns false if the vault is balanced", async () => {
      expect(await vaultHub.canForceValidatorWithdrawal(vaultAddress)).to.be.false;
    });

    it("returns false if the vault is unbalanced and the time is not yet reached", async () => {
      await reportUnbalancedVault();

      expect(await vaultHub.canForceValidatorWithdrawal(vaultAddress)).to.be.false;
    });

    it("returns true if the vault is unbalanced and the time is reached", async () => {
      const unbalancedUntil = await reportUnbalancedVault();
      const future = unbalancedUntil + 1000n;

      await advanceChainTime(future);

      expect(await getCurrentBlockTimestamp()).to.be.gt(future);
      expect(await vaultHub.canForceValidatorWithdrawal(vaultAddress)).to.be.true;
    });

    it("returns correct values for border cases", async () => {
      const unbalancedUntil = await reportUnbalancedVault();

      // 1 second before the unlock time
      await advanceChainTime(unbalancedUntil - (await getCurrentBlockTimestamp()) - 1n);
      expect(await getCurrentBlockTimestamp()).to.be.lt(unbalancedUntil);
      expect(await vaultHub.canForceValidatorWithdrawal(vaultAddress)).to.be.false;

      // exactly the unlock time
      await advanceChainTime(1n);
      expect(await getCurrentBlockTimestamp()).to.be.eq(unbalancedUntil);
      expect(await vaultHub.canForceValidatorWithdrawal(vaultAddress)).to.be.true;

      // 1 second after the unlock time
      await advanceChainTime(1n);
      expect(await getCurrentBlockTimestamp()).to.be.gt(unbalancedUntil);
      expect(await vaultHub.canForceValidatorWithdrawal(vaultAddress)).to.be.true;
    });
  });

  context("forceValidatorWithdrawal", () => {
    it("reverts if msg.value is 0", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, { value: 0n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if the vault is zero address", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(ZeroAddress, SAMPLE_PUBKEY, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_vault");
    });

    it("reverts if zero pubkeys", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, "0x", { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_pubkeys");
    });

    it("reverts if vault is not connected to the hub", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(stranger, SAMPLE_PUBKEY, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(stranger.address);
    });

    it("reverts if called for a disconnected vault", async () => {
      await vaultHub.connect(user).disconnect(vaultAddress);

      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(vaultAddress);
    });

    it("reverts if called for a balanced vault", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "AlreadyBalanced")
        .withArgs(vaultAddress, 0n, 0n);
    });

    context("unbalanced vault", () => {
      let unbalancedUntil: bigint;

      beforeEach(async () => (unbalancedUntil = await reportUnbalancedVault()));

      it("reverts if the time is not yet reached", async () => {
        await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, { value: 1n }))
          .to.be.revertedWithCustomError(vaultHub, "ForceWithdrawalTimelockActive")
          .withArgs(vaultAddress, unbalancedUntil);
      });

      it("reverts if fees are insufficient or too high", async () => {
        await advanceChainTime(unbalancedUntil);

        await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, { value: 1n }))
          .to.be.revertedWithCustomError(vault, "InvalidValidatorWithdrawalFee")
          .withArgs(1n, FEE);

        await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, { value: FEE + 1n }))
          .to.be.revertedWithCustomError(vault, "InvalidValidatorWithdrawalFee")
          .withArgs(FEE + 1n, FEE);
      });

      it("initiates force validator withdrawal", async () => {
        await advanceChainTime(unbalancedUntil - 1n);

        await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, { value: FEE }))
          .to.emit(vaultHub, "VaultForceWithdrawalInitiated")
          .withArgs(vaultAddress, SAMPLE_PUBKEY);
      });

      it("initiates force validator withdrawal with multiple pubkeys", async () => {
        const numPubkeys = 3;
        const pubkeys = "0x" + "ab".repeat(numPubkeys * 48);
        await advanceChainTime(unbalancedUntil - 1n);

        await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, pubkeys, { value: FEE * BigInt(numPubkeys) }))
          .to.emit(vaultHub, "VaultForceWithdrawalInitiated")
          .withArgs(vaultAddress, pubkeys);
      });
    });
  });

  context("_vaultAssessment & _epicrisis", () => {
    beforeEach(async () => await makeVaultUnbalanced());

    it("sets the unlock time and emits the event if the vault is unbalanced (via rebalance)", async () => {
      // Hacky way to get the unlock time right
      const tx = await vaultHub.connect(vaultSigner).rebalance({ value: 1n });
      const events = await findEvents((await tx.wait()) as ContractTransactionReceipt, "VaultBecameUnbalanced");
      const unbalancedUntil = events[0].args.unlockTime;

      expect(unbalancedUntil).to.be.gte((await getCurrentBlockTimestamp()) + FORCE_WITHDRAWAL_TIMELOCK);

      await expect(tx).to.emit(vaultHub, "VaultBecameUnbalanced").withArgs(vaultAddress, unbalancedUntil);

      expect((await vaultHub["vaultSocket(address)"](vaultAddress)).unbalancedSince).to.be.eq(
        unbalancedUntil - FORCE_WITHDRAWAL_TIMELOCK,
      );
    });

    it("does not change the unlock time if the vault is already unbalanced and the unlock time is already set", async () => {
      // report the vault as unbalanced
      const tx = await vaultHub.connect(vaultSigner).rebalance({ value: 1n });
      const events = await findEvents((await tx.wait()) as ContractTransactionReceipt, "VaultBecameUnbalanced");
      const unbalancedUntil = events[0].args.unlockTime;

      await expect(await vaultHub.connect(vaultSigner).rebalance({ value: 1n })).to.not.emit(
        vaultHub,
        "VaultBecameUnbalanced",
      );

      expect((await vaultHub["vaultSocket(address)"](vaultAddress)).unbalancedSince).to.be.eq(
        unbalancedUntil - FORCE_WITHDRAWAL_TIMELOCK,
      );
    });

    it("resets the unlock time if the vault becomes balanced", async () => {
      // report the vault as unbalanced
      await vaultHub.connect(vaultSigner).rebalance({ value: 1n });

      // report the vault as balanced
      await expect(vaultHub.connect(vaultSigner).rebalance({ value: ether("0.1") }))
        .to.emit(vaultHub, "VaultBecameBalanced")
        .withArgs(vaultAddress);

      expect((await vaultHub["vaultSocket(address)"](vaultAddress)).unbalancedSince).to.be.eq(0n);
    });

    it("does not change the unlock time if the vault is already balanced", async () => {
      // report the vault as balanced
      await vaultHub.connect(vaultSigner).rebalance({ value: ether("0.1") });

      // report the vault as balanced again
      await expect(vaultHub.connect(vaultSigner).rebalance({ value: ether("0.1") })).to.not.emit(
        vaultHub,
        "VaultBecameBalanced",
      );

      expect((await vaultHub["vaultSocket(address)"](vaultAddress)).unbalancedSince).to.be.eq(0n);
    });

    it("maintains the same unbalanced unlock time across multiple rebalance calls while still unbalanced", async () => {
      // report the vault as unbalanced
      const tx = await vaultHub.connect(vaultSigner).rebalance({ value: 1n });
      const events = await findEvents((await tx.wait()) as ContractTransactionReceipt, "VaultBecameUnbalanced");
      const unbalancedSince = events[0].args.unlockTime - FORCE_WITHDRAWAL_TIMELOCK;

      // Advance time by less than FORCE_WITHDRAWAL_TIMELOCK.
      await advanceChainTime(1000n);

      await expect(vaultHub.connect(vaultSigner).rebalance({ value: 1n })).to.not.emit(
        vaultHub,
        "VaultBecameUnbalanced",
      );

      expect((await vaultHub["vaultSocket(address)"](vaultAddress)).unbalancedSince).to.be.eq(unbalancedSince);

      // report the vault as unbalanced again
      await expect(vaultHub.connect(vaultSigner).rebalance({ value: 1n })).to.not.emit(
        vaultHub,
        "VaultBecameUnbalanced",
      );

      expect((await vaultHub["vaultSocket(address)"](vaultAddress)).unbalancedSince).to.be.eq(unbalancedSince);
    });
  });
});
