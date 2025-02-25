import { expect } from "chai";
import { ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  DepositContract__MockForStakingVault,
  EIP7002WithdrawalRequest_Mock,
  EthRejector,
  StakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import { computeDepositDataRoot, de0x, ether, impersonate, MAX_UINT256, proxify, streccak } from "lib";

import { deployStakingVaultBehindBeaconProxy, deployWithdrawalsPreDeployedMock } from "test/deploy";
import { Snapshot } from "test/suite";

const MAX_INT128 = 2n ** 127n - 1n;
const MAX_UINT128 = 2n ** 128n - 1n;

const PUBLIC_KEY_LENGTH = 48;
const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

const getPubkeys = (num: number): { pubkeys: string[]; stringified: string } => {
  const pubkeys = Array.from({ length: num }, (_, i) => {
    const paddedIndex = (i + 1).toString().padStart(8, "0");
    return `0x${paddedIndex.repeat(12)}`;
  });

  return {
    pubkeys,
    stringified: `0x${pubkeys.map(de0x).join("")}`,
  };
};

const encodeEip7002Input = (pubkey: string, amount: bigint): string => {
  return `${pubkey}${amount.toString(16).padStart(16, "0")}`;
};

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
  let withdrawalRequest: EIP7002WithdrawalRequest_Mock;
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

    // ERC7002 pre-deployed contract mock (0x00000961Ef480Eb55e80D19ad83579A64c007002)
    withdrawalRequest = await deployWithdrawalsPreDeployedMock(1n);
    ethRejector = await ethers.deployContract("EthRejector");

    vaultOwnerAddress = await vaultOwner.getAddress();
    stakingVaultAddress = await stakingVault.getAddress();
    vaultHubAddress = await vaultHub.getAddress();
    depositContractAddress = await depositContract.getAddress();
    ethRejectorAddress = await ethRejector.getAddress();

    vaultHubSigner = await impersonate(vaultHubAddress, ether("100"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

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
      await expect(ethers.deployContract("StakingVault", [vaultHubAddress, ZeroAddress]))
        .to.be.revertedWithCustomError(stakingVaultImplementation, "ZeroArgument")
        .withArgs("_beaconChainDepositContract");
    });
  });

  context("initialize", () => {
    it("petrifies the implementation by setting the initialized version to 2^64 - 1", async () => {
      expect(await stakingVaultImplementation.getInitializedVersion()).to.equal(2n ** 64n - 1n);
      expect(await stakingVaultImplementation.version()).to.equal(1n);
    });

    it("reverts on initialization", async () => {
      await expect(
        stakingVaultImplementation.connect(stranger).initialize(vaultOwner, operator, "0x"),
      ).to.be.revertedWithCustomError(stakingVaultImplementation, "InvalidInitialization");
    });

    it("reverts if the node operator is zero address", async () => {
      const [vault_] = await proxify({ impl: stakingVaultImplementation, admin: vaultOwner });
      await expect(vault_.initialize(vaultOwner, ZeroAddress, "0x")).to.be.revertedWithCustomError(
        stakingVaultImplementation,
        "ZeroArgument",
      );
    });
  });

  context("initial state (getters)", () => {
    it("returns the correct initial state and constants", async () => {
      expect(await stakingVault.DEPOSIT_CONTRACT()).to.equal(depositContractAddress);
      expect(await stakingVault.PUBLIC_KEY_LENGTH()).to.equal(PUBLIC_KEY_LENGTH);

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

    it("restores the vault to a healthy state if the vault was unhealthy", async () => {
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

    it.skip("reverts if vault is unhealthy", async () => {});

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

    it("can be called by the vault hub when the vault is unhealthy", async () => {
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

    it("reverts if the vault valuation is below the locked amount", async () => {
      await stakingVault.connect(vaultHubSigner).lock(ether("1"));
      await expect(
        stakingVault
          .connect(operator)
          .depositToBeaconChain([
            { pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") },
          ]),
      ).to.be.revertedWithCustomError(stakingVault, "ValuationBelowLockedAmount");
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

    it("makes deposits to the beacon chain and emits the `DepositedToBeaconChain` event", async () => {
      await stakingVault.fund({ value: ether("32") });

      const pubkey = "0x" + "ab".repeat(48);
      const signature = "0x" + "ef".repeat(96);
      const amount = ether("32");
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);

      await expect(
        stakingVault.connect(operator).depositToBeaconChain([{ pubkey, signature, amount, depositDataRoot }]),
      )
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(operator, 1, amount);
    });

    it("makes multiple deposits to the beacon chain and emits the `DepositedToBeaconChain` event", async () => {
      const numberOfKeys = 2; // number because of Array.from
      const totalAmount = ether("32") * BigInt(numberOfKeys);
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();

      // topup the contract with enough ETH to cover the deposits
      await setBalance(stakingVaultAddress, ether("32") * BigInt(numberOfKeys));

      const deposits = Array.from({ length: numberOfKeys }, (_, i) => {
        const pubkey = "0x" + `0${i}`.repeat(48);
        const signature = "0x" + `0${i}`.repeat(96);
        const amount = ether("32");
        const depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);
        return { pubkey, signature, amount, depositDataRoot };
      });

      await expect(stakingVault.connect(operator).depositToBeaconChain(deposits))
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(operator, 2, totalAmount);
    });
  });

  context("calculateValidatorWithdrawalFee", () => {
    it("reverts if the number of validators is zero", async () => {
      await expect(stakingVault.calculateValidatorWithdrawalFee(0))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_numberOfKeys");
    });

    it("works with max uint256", async () => {
      const fee = BigInt(await withdrawalRequest.fee());
      expect(await stakingVault.calculateValidatorWithdrawalFee(MAX_UINT256)).to.equal(BigInt(MAX_UINT256) * fee);
    });

    it("calculates the total fee for given number of validator keys", async () => {
      const newFee = 100n;
      await withdrawalRequest.setFee(newFee);

      const fee = await stakingVault.calculateValidatorWithdrawalFee(1n);
      expect(fee).to.equal(newFee);

      const feePerRequest = await withdrawalRequest.fee();
      expect(fee).to.equal(feePerRequest);

      const feeForMultipleKeys = await stakingVault.calculateValidatorWithdrawalFee(2n);
      expect(feeForMultipleKeys).to.equal(newFee * 2n);
    });
  });

  context("requestValidatorExit", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).requestValidatorExit("0x"))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(stranger);
    });

    it("reverts if the number of validators is zero", async () => {
      await expect(stakingVault.connect(vaultOwner).requestValidatorExit("0x"))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_pubkeys");
    });

    it("reverts if the length of the pubkeys is not a multiple of 48", async () => {
      await expect(
        stakingVault.connect(vaultOwner).requestValidatorExit("0x" + "ab".repeat(47)),
      ).to.be.revertedWithCustomError(stakingVault, "InvalidPubkeysLength");
    });

    it("emits the `ValidatorExitRequested` event for a single validator key", async () => {
      await expect(stakingVault.connect(vaultOwner).requestValidatorExit(SAMPLE_PUBKEY))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(vaultOwner, SAMPLE_PUBKEY, SAMPLE_PUBKEY);
    });

    it("emits the exact number of `ValidatorExitRequested` events as the number of validator keys", async () => {
      const numberOfKeys = 2;
      const keys = getPubkeys(numberOfKeys);

      const tx = await stakingVault.connect(vaultOwner).requestValidatorExit(keys.stringified);
      await expect(tx.wait())
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(vaultOwner, keys.pubkeys[0], keys.pubkeys[0])
        .and.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(vaultOwner, keys.pubkeys[1], keys.pubkeys[1]);

      const receipt = (await tx.wait()) as ContractTransactionReceipt;
      expect(receipt.logs.length).to.equal(numberOfKeys);
    });
  });

  context("triggerValidatorWithdrawal", () => {
    let baseFee: bigint;

    before(async () => {
      baseFee = BigInt(await withdrawalRequest.fee());
    });

    it("reverts if msg.value is zero", async () => {
      await expect(stakingVault.connect(vaultOwner).triggerValidatorWithdrawal("0x", [], vaultOwnerAddress))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if the number of validators is zero", async () => {
      await expect(
        stakingVault.connect(vaultOwner).triggerValidatorWithdrawal("0x", [], vaultOwnerAddress, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_pubkeys");
    });

    it("reverts if the amounts array is empty", async () => {
      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [], vaultOwnerAddress, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_amounts");
    });

    it("reverts if called by a non-owner or the node operator", async () => {
      await expect(
        stakingVault
          .connect(stranger)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], vaultOwnerAddress, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("triggerValidatorWithdrawal", stranger);
    });

    it("reverts if called by the vault hub on a healthy vault", async () => {
      await expect(
        stakingVault
          .connect(vaultHubSigner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], vaultOwnerAddress, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("triggerValidatorWithdrawal", vaultHubAddress);
    });

    it("reverts if the amounts array is not the same length as the pubkeys array", async () => {
      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1"), ether("2")], vaultOwnerAddress, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingVault, "InvalidAmountsLength");
    });

    it("reverts if the fee is less than the required fee", async () => {
      const numberOfKeys = 4;
      const pubkeys = getPubkeys(numberOfKeys);
      const amounts = Array(numberOfKeys).fill(ether("1"));
      const value = baseFee * BigInt(numberOfKeys) - 1n;

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(pubkeys.stringified, amounts, vaultOwnerAddress, { value }),
      )
        .to.be.revertedWithCustomError(stakingVault, "InsufficientValidatorWithdrawalFee")
        .withArgs(value, baseFee * BigInt(numberOfKeys));
    });

    it("reverts if the refund fails", async () => {
      const numberOfKeys = 1;
      const overpaid = 100n;
      const pubkeys = getPubkeys(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys) + overpaid;

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(pubkeys.stringified, [ether("1")], ethRejectorAddress, { value }),
      )
        .to.be.revertedWithCustomError(stakingVault, "WithdrawalFeeRefundFailed")
        .withArgs(ethRejectorAddress, overpaid);
    });

    it("reverts if partial withdrawals is called on an unhealthy vault", async () => {
      await stakingVault.fund({ value: ether("1") });
      await stakingVault.connect(vaultHubSigner).report(ether("0.9"), ether("1"), ether("1.1")); // slashing

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], vaultOwnerAddress, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingVault, "PartialWithdrawalNotAllowed");
    });

    it("requests a validator withdrawal when called by the owner", async () => {
      const value = baseFee;

      await expect(
        stakingVault.connect(vaultOwner).triggerValidatorWithdrawal(SAMPLE_PUBKEY, [0n], vaultOwnerAddress, { value }),
      )
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, SAMPLE_PUBKEY, [0n], vaultOwnerAddress, 0n);
    });

    it("requests a validator withdrawal when called by the node operator", async () => {
      await expect(
        stakingVault
          .connect(operator)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [0n], vaultOwnerAddress, { value: baseFee }),
      )
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(operator, SAMPLE_PUBKEY, [0n], vaultOwnerAddress, 0n);
    });

    it("requests a full validator withdrawal", async () => {
      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [0n], vaultOwnerAddress, { value: baseFee }),
      )
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, SAMPLE_PUBKEY, [0n], vaultOwnerAddress, 0n);
    });

    it("requests a partial validator withdrawal", async () => {
      const amount = ether("0.1");
      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [amount], vaultOwnerAddress, { value: baseFee }),
      )
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, amount), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, SAMPLE_PUBKEY, [amount], vaultOwnerAddress, 0);
    });

    it("requests a partial validator withdrawal and refunds the excess fee to the msg.sender if the refund recipient is the zero address", async () => {
      const amount = ether("0.1");
      const overpaid = 100n;
      const ownerBalanceBefore = await ethers.provider.getBalance(vaultOwner);

      const tx = await stakingVault
        .connect(vaultOwner)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [amount], ZeroAddress, { value: baseFee + overpaid });

      await expect(tx)
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, amount), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, SAMPLE_PUBKEY, [amount], vaultOwnerAddress, overpaid);

      const txReceipt = (await tx.wait()) as ContractTransactionReceipt;
      const gasFee = txReceipt.gasPrice * txReceipt.cumulativeGasUsed;

      const ownerBalanceAfter = await ethers.provider.getBalance(vaultOwner);

      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore - baseFee - gasFee); // overpaid is refunded back
    });

    it("requests a multiple validator withdrawals", async () => {
      const numberOfKeys = 2;
      const pubkeys = getPubkeys(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys);
      const amounts = Array(numberOfKeys)
        .fill(0)
        .map((_, i) => BigInt(i * 100)); // trigger full and partial withdrawals

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(pubkeys.stringified, amounts, vaultOwnerAddress, { value }),
      )
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], amounts[0]), baseFee)
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[1], amounts[1]), baseFee)
        .and.to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, pubkeys.stringified, amounts, vaultOwnerAddress, 0n);
    });

    it("requests a multiple validator withdrawals and refunds the excess fee to the fee recipient", async () => {
      const numberOfKeys = 2;
      const pubkeys = getPubkeys(numberOfKeys);
      const amounts = Array(numberOfKeys).fill(0); // trigger full withdrawals
      const valueToRefund = 100n * BigInt(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys) + valueToRefund;

      const strangerBalanceBefore = await ethers.provider.getBalance(stranger);

      await expect(
        stakingVault.connect(vaultOwner).triggerValidatorWithdrawal(pubkeys.stringified, amounts, stranger, { value }),
      )
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], amounts[0]), baseFee)
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[1], amounts[1]), baseFee)
        .and.to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, pubkeys.stringified, amounts, stranger, valueToRefund);

      const strangerBalanceAfter = await ethers.provider.getBalance(stranger);
      expect(strangerBalanceAfter).to.equal(strangerBalanceBefore + valueToRefund);
    });

    it("requests a validator withdrawal if called by the vault hub on an unhealthy vault", async () => {
      await stakingVault.fund({ value: ether("1") });
      await stakingVault.connect(vaultHubSigner).report(ether("0.9"), ether("1"), ether("1.1")); // slashing

      await expect(
        stakingVault
          .connect(vaultHubSigner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [0n], vaultOwnerAddress, { value: 1n }),
      )
        .to.emit(withdrawalRequest, "eip7002MockRequestAdded")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee);
    });
  });

  context("computeDepositDataRoot", () => {
    it("computes the deposit data root", async () => {
      // sample tx data: https://etherscan.io/tx/0x02980d44c119b0a8e3ca0d31c288e9f177c76fb4d7ab616563e399dd9c7c6507
      const pubkey =
        "0x8d6aa059b52f6b11d07d73805d409feba07dffb6442c4ef6645f7caa4038b1047e072cba21eb766579f8286ccac630b0";
      const withdrawalCredentials = "0x010000000000000000000000b8b5da17a1b7a8ad1cf45a12e1e61d3577052d35";
      const signature =
        "0xab95e358d002fd79bc08564a2db057dd5164af173915eba9e3e9da233d404c0eb0058760bc30cb89abbc55cf57f0c5a6018cdb17df73ca39ddc80a323a13c2e7ba942faa86757b26120b3a58dcce5d89e95ea1ee8fa3276ffac0f0ad9313211d";
      const amount = ether("32");
      const expectedDepositDataRoot = "0xb28f86815813d7da8132a2979836b326094a350e7aa301ba611163d4b7ca77be";

      computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);

      expect(await stakingVault.computeDepositDataRoot(pubkey, withdrawalCredentials, signature, amount)).to.equal(
        expectedDepositDataRoot,
      );
    });
  });
});
