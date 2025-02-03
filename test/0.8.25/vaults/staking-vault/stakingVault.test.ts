import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  DepositContract__MockForStakingVault,
  EthRejector,
  StakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import { computeDepositDataRoot, de0x, ether, impersonate, streccak } from "lib";

import { deployStakingVaultBehindBeaconProxy } from "test/deploy";
import { Snapshot } from "test/suite";

const MAX_INT128 = 2n ** 127n - 1n;
const MAX_UINT128 = 2n ** 128n - 1n;

// @TODO: test reentrancy attacks
describe("StakingVault.sol", () => {
  let vaultOwner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let elRewardsSender: HardhatEthersSigner;
  let vaultHubSigner: HardhatEthersSigner;

  let stakingVault: StakingVault;
  let stakingVaultImplementation: StakingVault;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultHub: VaultHub__MockForStakingVault;
  let ethRejector: EthRejector;

  let vaultOwnerAddress: string;
  let stakingVaultAddress: string;
  let vaultHubAddress: string;
  let depositContractAddress: string;
  let ethRejectorAddress: string;
  let originalState: string;

  before(async () => {
    [vaultOwner, operator, elRewardsSender, stranger] = await ethers.getSigners();
    ({ stakingVault, vaultHub, stakingVaultImplementation, depositContract } =
      await deployStakingVaultBehindBeaconProxy(vaultOwner, operator));

    ethRejector = await ethers.deployContract("EthRejector");

    vaultOwnerAddress = await vaultOwner.getAddress();
    stakingVaultAddress = await stakingVault.getAddress();
    vaultHubAddress = await vaultHub.getAddress();
    depositContractAddress = await depositContract.getAddress();
    ethRejectorAddress = await ethRejector.getAddress();

    vaultHubSigner = await impersonate(vaultHubAddress, ether("10"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("sets the vault hub address in the implementation", async () => {
      expect(await stakingVaultImplementation.vaultHub()).to.equal(vaultHubAddress);
    });

    it("sets the deposit contract address in the implementation", async () => {
      expect(await stakingVaultImplementation.depositContract()).to.equal(depositContractAddress);
    });

    it("reverts on construction if the vault hub address is zero", async () => {
      await expect(ethers.deployContract("StakingVault", [ZeroAddress, depositContractAddress]))
        .to.be.revertedWithCustomError(stakingVaultImplementation, "ZeroArgument")
        .withArgs("_vaultHub");
    });

    it("petrifies the implementation by setting the initialized version to 2^64 - 1", async () => {
      expect(await stakingVaultImplementation.getInitializedVersion()).to.equal(2n ** 64n - 1n);
      expect(await stakingVaultImplementation.version()).to.equal(1n);
    });

    it("reverts on initialization", async () => {
      await expect(
        stakingVaultImplementation.connect(stranger).initialize(vaultOwner, operator, "0x"),
      ).to.be.revertedWithCustomError(stakingVaultImplementation, "InvalidInitialization");
    });
  });

  context("initial state (getters)", () => {
    it("returns the correct initial state and constants", async () => {
      expect(await stakingVault.owner()).to.equal(await vaultOwner.getAddress());

      expect(await stakingVault.getInitializedVersion()).to.equal(1n);
      expect(await stakingVault.version()).to.equal(1n);
      expect(await stakingVault.vaultHub()).to.equal(vaultHubAddress);
      expect(await stakingVault.valuation()).to.equal(0n);
      expect(await stakingVault.locked()).to.equal(0n);
      expect(await stakingVault.unlocked()).to.equal(0n);
      expect(await stakingVault.inOutDelta()).to.equal(0n);
      expect(await stakingVault.latestReport()).to.deep.equal([0n, 0n]);
      expect(await stakingVault.nodeOperator()).to.equal(operator);

      expect(await stakingVault.depositContract()).to.equal(depositContractAddress);
      expect((await stakingVault.withdrawalCredentials()).toLowerCase()).to.equal(
        ("0x02" + "00".repeat(11) + de0x(stakingVaultAddress)).toLowerCase(),
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  context("valuation", () => {
    it("returns the correct valuation", async () => {
      expect(await stakingVault.valuation()).to.equal(0n);

      await stakingVault.fund({ value: ether("1") });
      expect(await stakingVault.valuation()).to.equal(ether("1"));
    });
  });

  context("locked", () => {
    it("returns the correct locked balance", async () => {
      expect(await stakingVault.locked()).to.equal(0n);

      await stakingVault.connect(vaultHubSigner).lock(ether("1"));
      expect(await stakingVault.locked()).to.equal(ether("1"));
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

  context("inOutDelta", () => {
    it("returns the correct inOutDelta", async () => {
      expect(await stakingVault.inOutDelta()).to.equal(0n);

      await stakingVault.fund({ value: ether("1") });
      expect(await stakingVault.inOutDelta()).to.equal(ether("1"));

      await stakingVault.withdraw(vaultOwnerAddress, ether("1"));
      expect(await stakingVault.inOutDelta()).to.equal(0n);
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

  context("nodeOperator", () => {
    it("returns the correct node operator", async () => {
      expect(await stakingVault.nodeOperator()).to.equal(operator);
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

    it("restores the vault to a balanced state if the vault was unbalanced", async () => {
      await stakingVault.connect(vaultHubSigner).lock(ether("1"));
      expect(await stakingVault.valuation()).to.be.lessThan(await stakingVault.locked());

      await stakingVault.fund({ value: ether("1") });
      expect(await stakingVault.valuation()).to.be.greaterThanOrEqual(await stakingVault.locked());
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

    it.skip("reverts is vault is unbalanced", async () => {});

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
      expect(await stakingVault.valuation()).to.be.lessThan(await stakingVault.locked());
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

  context("depositContract", () => {
    it("returns the correct deposit contract address", async () => {
      expect(await stakingVault.depositContract()).to.equal(depositContractAddress);
    });
  });

  context("withdrawalCredentials", () => {
    it("returns the correct withdrawal credentials in 0x02 format", async () => {
      const withdrawalCredentials = ("0x02" + "00".repeat(11) + de0x(stakingVaultAddress)).toLowerCase();
      expect(await stakingVault.withdrawalCredentials()).to.equal(withdrawalCredentials);
    });
  });

  context("beaconChainDepositsPaused", () => {
    it("returns the correct beacon chain deposits paused status", async () => {
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      await stakingVault.connect(vaultOwner).resumeBeaconChainDeposits();
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  context("pauseBeaconChainDeposits", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).pauseBeaconChainDeposits())
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("reverts if the beacon deposits are already paused", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();

      await expect(stakingVault.connect(vaultOwner).pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsResumeExpected",
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
        "BeaconChainDepositsPauseExpected",
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
      await expect(
        stakingVault
          .connect(stranger)
          .depositToBeaconChain([
            { pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") },
          ]),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("depositToBeaconChain", stranger);
    });

    it("reverts if the number of deposits is zero", async () => {
      await expect(stakingVault.depositToBeaconChain([]))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_deposits");
    });

    it("reverts if the vault is not balanced", async () => {
      await stakingVault.connect(vaultHubSigner).lock(ether("1"));
      await expect(
        stakingVault
          .connect(operator)
          .depositToBeaconChain([
            { pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") },
          ]),
      ).to.be.revertedWithCustomError(stakingVault, "Unbalanced");
    });

    it("reverts if the deposits are paused", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();
      await expect(
        stakingVault
          .connect(operator)
          .depositToBeaconChain([
            { pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") },
          ]),
      ).to.be.revertedWithCustomError(stakingVault, "BeaconChainDepositsArePaused");
    });

    it("makes deposits to the beacon chain and emits the DepositedToBeaconChain event", async () => {
      await stakingVault.fund({ value: ether("32") });

      const pubkey = "0x" + "ab".repeat(48);
      const signature = "0x" + "ef".repeat(96);
      const amount = ether("32");
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);

      await expect(
        stakingVault.connect(operator).depositToBeaconChain([{ pubkey, signature, amount, depositDataRoot }]),
      )
        .to.emit(stakingVault, "Deposited")
        .withArgs(operator, 1, amount);
    });
  });
});
