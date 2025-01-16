import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  DepositContract__MockForStakingVault,
  EthRejector,
  StakingVault,
  StakingVault__factory,
  VaultFactory__MockForStakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import { de0x, ether, findEvents, impersonate } from "lib";

import { Snapshot } from "test/suite";

const MAX_INT128 = 2n ** 127n - 1n;
const MAX_UINT128 = 2n ** 128n - 1n;

// @TODO: test reentrancy attacks
describe("StakingVault", () => {
  let vaultOwner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let beaconSigner: HardhatEthersSigner;
  let elRewardsSender: HardhatEthersSigner;
  let vaultHubSigner: HardhatEthersSigner;

  let stakingVault: StakingVault;
  let stakingVaultImplementation: StakingVault;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultHub: VaultHub__MockForStakingVault;
  let vaultFactory: VaultFactory__MockForStakingVault;
  let ethRejector: EthRejector;

  let vaultOwnerAddress: string;
  let stakingVaultAddress: string;
  let vaultHubAddress: string;
  let vaultFactoryAddress: string;
  let depositContractAddress: string;
  let beaconAddress: string;
  let ethRejectorAddress: string;
  let originalState: string;

  before(async () => {
    [vaultOwner, operator, elRewardsSender, stranger] = await ethers.getSigners();
    [stakingVault, vaultHub, vaultFactory, stakingVaultImplementation, depositContract] =
      await deployStakingVaultBehindBeaconProxy();
    ethRejector = await ethers.deployContract("EthRejector");

    vaultOwnerAddress = await vaultOwner.getAddress();
    stakingVaultAddress = await stakingVault.getAddress();
    vaultHubAddress = await vaultHub.getAddress();
    depositContractAddress = await depositContract.getAddress();
    beaconAddress = await stakingVaultImplementation.getBeacon();
    vaultFactoryAddress = await vaultFactory.getAddress();
    ethRejectorAddress = await ethRejector.getAddress();

    beaconSigner = await impersonate(beaconAddress, ether("10"));
    vaultHubSigner = await impersonate(vaultHubAddress, ether("10"));
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("constructor", () => {
    it("sets the vault hub address in the implementation", async () => {
      expect(await stakingVaultImplementation.vaultHub()).to.equal(vaultHubAddress);
    });

    it("sets the deposit contract address in the implementation", async () => {
      expect(await stakingVaultImplementation.DEPOSIT_CONTRACT()).to.equal(depositContractAddress);
    });

    it("reverts on construction if the vault hub address is zero", async () => {
      await expect(ethers.deployContract("StakingVault", [ZeroAddress, depositContractAddress]))
        .to.be.revertedWithCustomError(stakingVaultImplementation, "ZeroArgument")
        .withArgs("_vaultHub");
    });

    it("reverts on construction if the deposit contract address is zero", async () => {
      await expect(ethers.deployContract("StakingVault", [vaultHubAddress, ZeroAddress])).to.be.revertedWithCustomError(
        stakingVaultImplementation,
        "DepositContractZeroAddress",
      );
    });

    it("petrifies the implementation by setting the initialized version to 2^64 - 1", async () => {
      expect(await stakingVaultImplementation.getInitializedVersion()).to.equal(2n ** 64n - 1n);
      expect(await stakingVaultImplementation.version()).to.equal(1n);
    });

    it("reverts on initialization", async () => {
      await expect(
        stakingVaultImplementation.connect(beaconSigner).initialize(vaultOwner, operator, "0x"),
      ).to.be.revertedWithCustomError(stakingVaultImplementation, "InvalidInitialization");
    });

    it("reverts on initialization if the caller is not the beacon", async () => {
      await expect(stakingVaultImplementation.connect(stranger).initialize(vaultOwner, operator, "0x"))
        .to.be.revertedWithCustomError(stakingVaultImplementation, "SenderNotBeacon")
        .withArgs(stranger, await stakingVaultImplementation.getBeacon());
    });
  });

  context("initial state", () => {
    it("returns the correct initial state and constants", async () => {
      expect(await stakingVault.version()).to.equal(1n);
      expect(await stakingVault.getInitializedVersion()).to.equal(1n);
      expect(await stakingVault.vaultHub()).to.equal(vaultHubAddress);
      expect(await stakingVault.DEPOSIT_CONTRACT()).to.equal(depositContractAddress);
      expect(await stakingVault.getBeacon()).to.equal(vaultFactoryAddress);
      expect(await stakingVault.owner()).to.equal(await vaultOwner.getAddress());
      expect(await stakingVault.nodeOperator()).to.equal(operator);
      expect(await stakingVault.locked()).to.equal(0n);
      expect(await stakingVault.unlocked()).to.equal(0n);
      expect(await stakingVault.inOutDelta()).to.equal(0n);
      expect((await stakingVault.withdrawalCredentials()).toLowerCase()).to.equal(
        ("0x01" + "00".repeat(11) + de0x(stakingVaultAddress)).toLowerCase(),
      );
      expect(await stakingVault.valuation()).to.equal(0n);
      expect(await stakingVault.isBalanced()).to.be.true;
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  context("unlocked", () => {
    it("returns the correct unlocked balance", async () => {
      expect(await stakingVault.unlocked()).to.equal(0n);
    });

    it("returns 0 if locked amount is greater than valuation", async () => {
      await stakingVault.connect(vaultHubSigner).lock(ether("1"));
      expect(await stakingVault.valuation()).to.equal(ether("0"));
      expect(await stakingVault.locked()).to.equal(ether("1"));

      expect(await stakingVault.unlocked()).to.equal(0n);
    });
  });

  context("latestReport", () => {
    it("returns zeros initially", async () => {
      expect(await stakingVault.latestReport()).to.deep.equal([0n, 0n]);
    });

    it("returns the latest report", async () => {
      await stakingVault.connect(vaultHubSigner).report(ether("1"), ether("2"), ether("0"));
      expect(await stakingVault.latestReport()).to.deep.equal([ether("1"), ether("2")]);
    });
  });

  context("receive", () => {
    it("reverts if msg.value is zero", async () => {
      await expect(vaultOwner.sendTransaction({ to: stakingVaultAddress, value: 0n }))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("receives direct transfers without updating inOutDelta", async () => {
      const inOutDeltaBefore = await stakingVault.inOutDelta();
      const balanceBefore = await ethers.provider.getBalance(stakingVaultAddress);
      await expect(vaultOwner.sendTransaction({ to: stakingVaultAddress, value: ether("1") })).to.not.be.reverted;
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(balanceBefore + ether("1"));
      expect(await stakingVault.inOutDelta()).to.equal(inOutDeltaBefore);
    });
  });

  context("fund", () => {
    it("reverts if msg.value is zero", async () => {
      await expect(stakingVault.fund({ value: 0n }))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).fund({ value: ether("1") }))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("updates inOutDelta and emits the Funded event", async () => {
      const inOutDeltaBefore = await stakingVault.inOutDelta();
      await expect(stakingVault.fund({ value: ether("1") }))
        .to.emit(stakingVault, "Funded")
        .withArgs(vaultOwnerAddress, ether("1"));
      expect(await stakingVault.inOutDelta()).to.equal(inOutDeltaBefore + ether("1"));
      expect(await stakingVault.valuation()).to.equal(ether("1"));
    });

    it("does not revert if the amount is max int128", async () => {
      const maxInOutDelta = MAX_INT128;
      const forGas = ether("10");
      const bigBalance = maxInOutDelta + forGas;
      await setBalance(vaultOwnerAddress, bigBalance);
      await expect(stakingVault.fund({ value: maxInOutDelta })).to.not.be.reverted;
    });
  });

  context("withdraw", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).withdraw(vaultOwnerAddress, ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("reverts if the recipient is the zero address", async () => {
      await expect(stakingVault.withdraw(ZeroAddress, ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("reverts if the amount is zero", async () => {
      await expect(stakingVault.withdraw(vaultOwnerAddress, 0n))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_ether");
    });

    it("reverts if insufficient balance", async () => {
      const balance = await ethers.provider.getBalance(stakingVaultAddress);

      await expect(stakingVault.withdraw(vaultOwnerAddress, balance + 1n))
        .to.be.revertedWithCustomError(stakingVault, "InsufficientBalance")
        .withArgs(balance);
    });

    it("reverts if insufficient unlocked balance", async () => {
      const balance = ether("1");
      const locked = ether("1") - 1n;
      const unlocked = balance - locked;
      await stakingVault.fund({ value: balance });
      await stakingVault.connect(vaultHubSigner).lock(locked);

      await expect(stakingVault.withdraw(vaultOwnerAddress, balance))
        .to.be.revertedWithCustomError(stakingVault, "InsufficientUnlocked")
        .withArgs(unlocked);
    });

    it("does not revert on max int128", async () => {
      const forGas = ether("10");
      const bigBalance = MAX_INT128 + forGas;
      await setBalance(vaultOwnerAddress, bigBalance);
      await stakingVault.fund({ value: MAX_INT128 });

      await expect(stakingVault.withdraw(vaultOwnerAddress, MAX_INT128))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(vaultOwnerAddress, vaultOwnerAddress, MAX_INT128);
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);
      expect(await stakingVault.valuation()).to.equal(0n);
      expect(await stakingVault.inOutDelta()).to.equal(0n);
    });

    it("reverts if the recipient rejects the transfer", async () => {
      await stakingVault.fund({ value: ether("1") });
      await expect(stakingVault.withdraw(ethRejectorAddress, ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "TransferFailed")
        .withArgs(ethRejectorAddress, ether("1"));
    });

    it("sends ether to the recipient, updates inOutDelta, and emits the Withdrawn event (before any report or locks)", async () => {
      await stakingVault.fund({ value: ether("10") });

      await expect(stakingVault.withdraw(vaultOwnerAddress, ether("10")))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(vaultOwnerAddress, vaultOwnerAddress, ether("10"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);
      expect(await stakingVault.valuation()).to.equal(0n);
      expect(await stakingVault.inOutDelta()).to.equal(0n);
    });

    it("makes inOutDelta negative if withdrawals are greater than deposits (after rewards)", async () => {
      const valuation = ether("10");
      await stakingVault.connect(vaultHubSigner).report(valuation, ether("0"), ether("0"));
      expect(await stakingVault.valuation()).to.equal(valuation);
      expect(await stakingVault.inOutDelta()).to.equal(0n);

      const elRewardsAmount = ether("1");
      await elRewardsSender.sendTransaction({ to: stakingVaultAddress, value: elRewardsAmount });

      await expect(stakingVault.withdraw(vaultOwnerAddress, elRewardsAmount))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(vaultOwnerAddress, vaultOwnerAddress, elRewardsAmount);
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);
      expect(await stakingVault.valuation()).to.equal(valuation - elRewardsAmount);
      expect(await stakingVault.inOutDelta()).to.equal(-elRewardsAmount);
    });
  });

  context("pauseBeaconChainDeposits", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).pauseBeaconChainDeposits())
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("reverts if the beacon deposits are already paused", async () => {
      await expect(stakingVault.connect(vaultOwner).pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsPauseExpected",
      );
    });

    it("allows to pause deposits", async () => {
      await expect(stakingVault.connect(vaultOwner).pauseBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });
  });

  context("resumeBeaconChainDeposits", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).resumeBeaconChainDeposits())
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("reverts if the beacon deposits are already resumed", async () => {
      await expect(stakingVault.connect(vaultOwner).resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsResumeExpected",
      );
    });

    it("allows to resume deposits", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();

      await expect(stakingVault.connect(vaultOwner).resumeBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  context("depositToBeaconChain", () => {
    it("reverts if called by a non-operator", async () => {
      await expect(stakingVault.connect(stranger).depositToBeaconChain(1, "0x", "0x"))
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("depositToBeaconChain", stranger);
    });

    it("reverts if the number of deposits is zero", async () => {
      await expect(stakingVault.depositToBeaconChain(0, "0x", "0x"))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_numberOfDeposits");
    });

    it("reverts if the vault is not balanced", async () => {
      await stakingVault.connect(vaultHubSigner).lock(ether("1"));
      await expect(stakingVault.connect(operator).depositToBeaconChain(1, "0x", "0x")).to.be.revertedWithCustomError(
        stakingVault,
        "Unbalanced",
      );
    });

    it("reverts if the deposits are paused", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();
      await expect(stakingVault.connect(operator).depositToBeaconChain(1, "0x", "0x")).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsNotAllowed",
      );
    });

    it("makes deposits to the beacon chain and emits the DepositedToBeaconChain event", async () => {
      await stakingVault.fund({ value: ether("32") });

      const pubkey = "0x" + "ab".repeat(48);
      const signature = "0x" + "ef".repeat(96);
      await expect(stakingVault.connect(operator).depositToBeaconChain(1, pubkey, signature))
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(operator, 1, ether("32"));
    });
  });

  context("requestValidatorExit", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).requestValidatorExit("0x"))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("emits the ValidatorsExitRequest event", async () => {
      const pubkey = "0x" + "ab".repeat(48);
      await expect(stakingVault.requestValidatorExit(pubkey))
        .to.emit(stakingVault, "ValidatorsExitRequest")
        .withArgs(vaultOwnerAddress, pubkey);
    });
  });

  context("lock", () => {
    it("reverts if the caller is not the vault hub", async () => {
      await expect(stakingVault.connect(vaultOwner).lock(ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("lock", vaultOwnerAddress);
    });

    it("updates the locked amount and emits the Locked event", async () => {
      await expect(stakingVault.connect(vaultHubSigner).lock(ether("1")))
        .to.emit(stakingVault, "LockedIncreased")
        .withArgs(ether("1"));
      expect(await stakingVault.locked()).to.equal(ether("1"));
    });

    it("reverts if the new locked amount is less than the current locked amount", async () => {
      await stakingVault.connect(vaultHubSigner).lock(ether("2"));
      await expect(stakingVault.connect(vaultHubSigner).lock(ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "LockedCannotDecreaseOutsideOfReport")
        .withArgs(ether("2"), ether("1"));
    });

    it("does not revert if the new locked amount is equal to the current locked amount", async () => {
      await stakingVault.connect(vaultHubSigner).lock(ether("1"));
      await expect(stakingVault.connect(vaultHubSigner).lock(ether("2")))
        .to.emit(stakingVault, "LockedIncreased")
        .withArgs(ether("2"));
    });

    it("does not revert if the locked amount is max uint128", async () => {
      await expect(stakingVault.connect(vaultHubSigner).lock(MAX_UINT128))
        .to.emit(stakingVault, "LockedIncreased")
        .withArgs(MAX_UINT128);
    });
  });

  context("rebalance", () => {
    it("reverts if the amount is zero", async () => {
      await expect(stakingVault.rebalance(0n))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_ether");
    });

    it("reverts if the amount is greater than the vault's balance", async () => {
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);
      await expect(stakingVault.rebalance(1n))
        .to.be.revertedWithCustomError(stakingVault, "InsufficientBalance")
        .withArgs(0n);
    });

    it("reverts if the rebalance amount exceeds the valuation", async () => {
      await stranger.sendTransaction({ to: stakingVaultAddress, value: ether("1") });
      expect(await stakingVault.valuation()).to.equal(ether("0"));

      await expect(stakingVault.rebalance(ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "RebalanceAmountExceedsValuation")
        .withArgs(ether("0"), ether("1"));
    });

    it("reverts if the caller is not the owner or the vault hub", async () => {
      await stakingVault.fund({ value: ether("2") });

      await expect(stakingVault.connect(stranger).rebalance(ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("rebalance", stranger);
    });

    it("can be called by the owner", async () => {
      await stakingVault.fund({ value: ether("2") });
      const inOutDeltaBefore = await stakingVault.inOutDelta();
      await expect(stakingVault.rebalance(ether("1")))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(vaultOwnerAddress, vaultHubAddress, ether("1"))
        .to.emit(vaultHub, "Mock__Rebalanced")
        .withArgs(stakingVaultAddress, ether("1"));
      expect(await stakingVault.inOutDelta()).to.equal(inOutDeltaBefore - ether("1"));
    });

    it("can be called by the vault hub when the vault is unbalanced", async () => {
      await stakingVault.connect(vaultHubSigner).report(ether("1"), ether("0.1"), ether("1.1"));
      expect(await stakingVault.isBalanced()).to.equal(false);
      expect(await stakingVault.inOutDelta()).to.equal(ether("0"));
      await elRewardsSender.sendTransaction({ to: stakingVaultAddress, value: ether("0.1") });

      await expect(stakingVault.connect(vaultHubSigner).rebalance(ether("0.1")))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(vaultHubAddress, vaultHubAddress, ether("0.1"))
        .to.emit(vaultHub, "Mock__Rebalanced")
        .withArgs(stakingVaultAddress, ether("0.1"));
      expect(await stakingVault.inOutDelta()).to.equal(-ether("0.1"));
    });
  });

  context("report", () => {
    it("reverts if the caller is not the vault hub", async () => {
      await expect(stakingVault.connect(stranger).report(ether("1"), ether("2"), ether("3")))
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("report", stranger);
    });

    it("updates the state and emits the Reported event", async () => {
      await expect(stakingVault.connect(vaultHubSigner).report(ether("1"), ether("2"), ether("3")))
        .to.emit(stakingVault, "Reported")
        .withArgs(ether("1"), ether("2"), ether("3"));
      expect(await stakingVault.latestReport()).to.deep.equal([ether("1"), ether("2")]);
      expect(await stakingVault.locked()).to.equal(ether("3"));
    });
  });

  async function deployStakingVaultBehindBeaconProxy(): Promise<
    [
      StakingVault,
      VaultHub__MockForStakingVault,
      VaultFactory__MockForStakingVault,
      StakingVault,
      DepositContract__MockForStakingVault,
    ]
  > {
    // deploying implementation
    const vaultHub_ = await ethers.deployContract("VaultHub__MockForStakingVault");
    const depositContract_ = await ethers.deployContract("DepositContract__MockForStakingVault");
    const stakingVaultImplementation_ = await ethers.deployContract("StakingVault", [
      await vaultHub_.getAddress(),
      await depositContract_.getAddress(),
    ]);

    // deploying factory/beacon
    const vaultFactory_ = await ethers.deployContract("VaultFactory__MockForStakingVault", [
      await stakingVaultImplementation_.getAddress(),
    ]);

    // deploying beacon proxy
    const vaultCreation = await vaultFactory_
      .createVault(await vaultOwner.getAddress(), await operator.getAddress())
      .then((tx) => tx.wait());
    if (!vaultCreation) throw new Error("Vault creation failed");
    const events = findEvents(vaultCreation, "VaultCreated");
    if (events.length != 1) throw new Error("There should be exactly one VaultCreated event");
    const vaultCreatedEvent = events[0];

    const stakingVault_ = StakingVault__factory.connect(vaultCreatedEvent.args.vault, vaultOwner);
    expect(await stakingVault_.owner()).to.equal(await vaultOwner.getAddress());

    return [stakingVault_, vaultHub_, vaultFactory_, stakingVaultImplementation_, depositContract_];
  }
});
