import { expect } from "chai";
import { ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  DepositContract__MockForStakingVault,
  EIP7002WithdrawalRequest__Mock,
  EthRejector,
  StakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import {
  computeDepositDataRoot,
  de0x,
  deployEIP7002WithdrawalRequestContract,
  EIP7002_MIN_WITHDRAWAL_REQUEST_FEE,
  ether,
  generatePostDeposit,
  generateValidator,
  getCurrentBlockTimestamp,
  impersonate,
  MAX_UINT256,
  proxify,
  streccak,
} from "lib";

import { deployStakingVaultBehindBeaconProxy } from "test/deploy";
import { Snapshot } from "test/suite";

const MAX_INT128 = 2n ** 127n - 1n;

const PUBLIC_KEY_LENGTH = 48;
const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);
const INVALID_PUBKEY = "0x" + "ab".repeat(47);

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
  let depositor: HardhatEthersSigner;

  let stakingVault: StakingVault;
  let stakingVaultImplementation: StakingVault;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultHub: VaultHub__MockForStakingVault;
  let withdrawalRequestContract: EIP7002WithdrawalRequest__Mock;
  let ethRejector: EthRejector;
  let stakingVaultTimestamp: bigint;

  let vaultOwnerAddress: string;
  let stakingVaultAddress: string;
  let vaultHubAddress: string;
  let depositContractAddress: string;
  let ethRejectorAddress: string;

  let originalState: string;

  before(async () => {
    [vaultOwner, operator, elRewardsSender, depositor, stranger] = await ethers.getSigners();
    ({ stakingVault, vaultHub, stakingVaultImplementation, depositContract } =
      await deployStakingVaultBehindBeaconProxy(vaultOwner, operator, depositor));

    stakingVaultTimestamp = (await stakingVault.latestReport())[2];
    withdrawalRequestContract = await deployEIP7002WithdrawalRequestContract(EIP7002_MIN_WITHDRAWAL_REQUEST_FEE);
    ethRejector = await ethers.deployContract("EthRejector");

    vaultOwnerAddress = await vaultOwner.getAddress();
    stakingVaultAddress = await stakingVault.getAddress();
    vaultHubAddress = await vaultHub.getAddress();
    depositContractAddress = await depositContract.getAddress();
    ethRejectorAddress = await ethRejector.getAddress();

    vaultHubSigner = await impersonate(vaultHubAddress, ether("100"));

    await stakingVault.deauthorizeLidoVaultHub(); // make sure vault is deauthorized
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
        stakingVaultImplementation.connect(stranger).initialize(vaultOwner, operator, depositor, "0x"),
      ).to.be.revertedWithCustomError(stakingVaultImplementation, "InvalidInitialization");
    });

    it("reverts if the node operator is zero address", async () => {
      const [vault_] = await proxify({ impl: stakingVaultImplementation, admin: vaultOwner });
      await expect(vault_.initialize(vaultOwner, ZeroAddress, depositor, "0x"))
        .to.be.revertedWithCustomError(stakingVaultImplementation, "ZeroArgument")
        .withArgs("_nodeOperator");
    });

    it("no reverts if the `_depositor` is zero address", async () => {
      const [vault_] = await proxify({ impl: stakingVaultImplementation, admin: vaultOwner });
      await expect(vault_.initialize(vaultOwner, operator, ZeroAddress, "0x")).to.not.be.reverted;

      expect(await vault_.depositor()).to.equal(operator);
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
      expect(await stakingVault.latestReport()).to.deep.equal([0n, 0n, stakingVaultTimestamp]);
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

      const amount = ether("1");
      await stakingVault.fund({ value: amount });

      await stakingVault.connect(vaultOwner).lock(amount);
      expect(await stakingVault.locked()).to.equal(amount);
    });
  });

  context("resetLocked", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).resetLocked()).to.be.revertedWithCustomError(
        stakingVault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts if vaultHub already authorized", async () => {
      await stakingVault.authorizeLidoVaultHub();
      await expect(stakingVault.resetLocked()).to.be.revertedWithCustomError(stakingVault, "VaultHubAuthorized");
    });

    it("works on deauthorized vault", async () => {
      await stakingVault.fund({ value: ether("1") });
      await stakingVault.lock(ether("1"));
      expect(await stakingVault.locked()).to.equal(ether("1"));

      await stakingVault.resetLocked();
      expect(await stakingVault.locked()).to.equal(0n);
    });
  });

  context("unlocked", () => {
    it("returns the correct unlocked balance", async () => {
      expect(await stakingVault.unlocked()).to.equal(0n);
    });

    it("returns 0 if locked amount is greater than valuation", async () => {
      const amount = ether("1");
      await stakingVault.fund({ value: amount });
      await stakingVault.authorizeLidoVaultHub(); // needed for the report

      await stakingVault
        .connect(vaultHubSigner)
        .report(
          await getCurrentBlockTimestamp(),
          await stakingVault.valuation(),
          await stakingVault.inOutDelta(),
          amount + 1n,
        );
      const timestamp = await getCurrentBlockTimestamp();
      await stakingVault.connect(vaultHubSigner).report(timestamp, amount - 1n, amount, amount); // locked > valuation

      expect(await stakingVault.valuation()).to.equal(amount - 1n);
      expect(await stakingVault.locked()).to.equal(amount);
      expect(await stakingVault.unlocked()).to.equal(0n);
    });

    it("returns the difference between valuation and locked if locked amount is less than or equal to valuation", async () => {
      const amount = ether("1");

      await stakingVault.fund({ value: amount });
      expect(await stakingVault.valuation()).to.equal(amount);
      expect(await stakingVault.locked()).to.equal(0n);
      expect(await stakingVault.unlocked()).to.equal(amount);

      const halfAmount = amount / 2n;
      await stakingVault.connect(vaultOwner).lock(halfAmount);

      expect(await stakingVault.valuation()).to.equal(amount);
      expect(await stakingVault.locked()).to.equal(halfAmount);
      expect(await stakingVault.unlocked()).to.equal(halfAmount);

      await stakingVault.connect(vaultOwner).lock(amount);
      expect(await stakingVault.valuation()).to.equal(amount);
      expect(await stakingVault.locked()).to.equal(amount);
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
      expect(await stakingVault.latestReport()).to.deep.equal([0n, 0n, stakingVaultTimestamp]);
    });

    it("returns the latest report", async () => {
      const timestamp = await getCurrentBlockTimestamp();
      await stakingVault.authorizeLidoVaultHub();

      await stakingVault.connect(vaultHubSigner).report(timestamp, ether("1"), ether("2"), ether("0"));
      expect(await stakingVault.latestReport()).to.deep.equal([ether("1"), ether("2"), timestamp]);
    });
  });

  context("nodeOperator", () => {
    it("returns the correct node operator", async () => {
      expect(await stakingVault.nodeOperator()).to.equal(operator);
    });
  });

  context("authorizeLidoVaultHub", () => {
    it("reverts on invalid owner", async () => {
      await expect(stakingVault.connect(stranger).authorizeLidoVaultHub()).to.revertedWithCustomError(
        stakingVault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts on vaultHubAuthorized", async () => {
      await stakingVault.authorizeLidoVaultHub();
      await expect(stakingVault.authorizeLidoVaultHub()).to.revertedWithCustomError(stakingVault, "VaultHubAuthorized");
    });

    it("reverts on ossified", async () => {
      await stakingVault.ossifyStakingVault();
      await expect(stakingVault.authorizeLidoVaultHub()).to.revertedWithCustomError(stakingVault, "VaultOssified");
    });

    it("reverts if depositor is not Lido Predeposit Guarantee", async () => {
      await stakingVault.setDepositor(stranger);

      await expect(stakingVault.authorizeLidoVaultHub()).to.revertedWithCustomError(stakingVault, "InvalidDepositor");
    });

    it("authorize works on deauthorized vault", async () => {
      await expect(stakingVault.authorizeLidoVaultHub()).to.emit(stakingVault, "VaultHubAuthorizedSet").withArgs(true);
    });
  });

  context("deauthorizeLidoVaultHub", () => {
    it("reverts on unauthorized", async () => {
      await expect(stakingVault.connect(stranger).deauthorizeLidoVaultHub()).to.revertedWithCustomError(
        stakingVault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts on VaultHubNotAuthorized", async () => {
      await expect(stakingVault.deauthorizeLidoVaultHub()).to.revertedWithCustomError(
        stakingVault,
        "VaultHubNotAuthorized",
      );
    });

    it("reverts if vault connected to VaultHub", async () => {
      await stakingVault.authorizeLidoVaultHub();
      await vaultHub.addVaultSocket(stakingVault);
      await expect(stakingVault.deauthorizeLidoVaultHub()).to.revertedWithCustomError(stakingVault, "VaultConnected");
    });

    it("deauthorize works", async () => {
      await stakingVault.authorizeLidoVaultHub();

      await expect(stakingVault.deauthorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(false);

      expect(await stakingVault.vaultHubAuthorized()).to.equal(false);
      expect(await stakingVault.depositor()).to.equal(depositor);
    });
  });

  context("ossification", () => {
    it("reverts on vaultHubAuthorized", async () => {
      await stakingVault.authorizeLidoVaultHub();

      await expect(stakingVault.ossifyStakingVault()).to.revertedWithCustomError(stakingVault, "VaultHubAuthorized");
    });

    it("reverts on stranger", async () => {
      await expect(stakingVault.connect(stranger).ossifyStakingVault()).to.revertedWithCustomError(
        stakingVault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts on already ossified", async () => {
      await stakingVault.ossifyStakingVault();

      await expect(stakingVault.ossifyStakingVault()).to.revertedWithCustomError(stakingVault, "AlreadyOssified");
    });

    it("ossify works on deauthorized vault", async () => {
      await expect(stakingVault.ossifyStakingVault()).to.emit(stakingVault, "PinnedImplementationUpdated");
    });
  });

  context("depositor", () => {
    it("returns the correct depositor", async () => {
      expect(await stakingVault.depositor()).to.equal(depositor);
    });

    it("reverts if invalid owner", async () => {
      await expect(stakingVault.connect(stranger).setDepositor(depositor))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(stranger);
    });

    it("reverts if _depositor is zero address", async () => {
      await expect(stakingVault.connect(vaultOwner).setDepositor(ZeroAddress))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_depositor");
    });

    it("reverts if vault is attached to VaultHub", async () => {
      await stakingVault.authorizeLidoVaultHub();

      await expect(stakingVault.connect(vaultOwner).setDepositor(depositor)).to.be.revertedWithCustomError(
        stakingVault,
        "VaultHubAuthorized",
      );
    });

    it("setDepositor works", async () => {
      await expect(stakingVault.connect(vaultOwner).setDepositor(stranger))
        .to.emit(stakingVault, "DepositorSet")
        .withArgs(stranger);

      expect(await stakingVault.depositor()).to.equal(stranger);
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
      const valuation = 0n;
      const inOutDelta = 0n;
      const locked = ether("1.0");
      const timestamp = await getCurrentBlockTimestamp();

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault.connect(vaultHubSigner).report(timestamp, valuation, inOutDelta, locked);
      expect(await stakingVault.valuation()).to.be.lessThan(locked);

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
      await stakingVault.connect(vaultOwner).lock(locked);

      await expect(stakingVault.withdraw(vaultOwnerAddress, balance))
        .to.be.revertedWithCustomError(stakingVault, "InsufficientUnlocked")
        .withArgs(unlocked);
    });

    it.skip("reverts if vault valuation is less than locked amount (reentrancy)", async () => {});

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

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), valuation, ether("0"), ether("0"));

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
    it("reverts if the caller is not the vault owner", async () => {
      await expect(stakingVault.connect(stranger).lock(ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("updates the locked amount and emits the Locked event", async () => {
      const amount = ether("1");
      await stakingVault.fund({ value: amount });

      await expect(stakingVault.connect(vaultOwner).lock(amount))
        .to.emit(stakingVault, "LockedIncreased")
        .withArgs(amount);
      expect(await stakingVault.locked()).to.equal(amount);
    });

    it("reverts if the new locked amount is less than the current locked amount", async () => {
      const amount = ether("1");
      await stakingVault.fund({ value: amount });

      await stakingVault.connect(vaultOwner).lock(amount);

      await expect(stakingVault.connect(vaultOwner).lock(amount - 1n)).to.be.revertedWithCustomError(
        stakingVault,
        "NewLockedNotGreaterThanCurrent",
      );
    });

    it("reverts if the new locked amount is equal to the current locked amount", async () => {
      const amount = ether("1");
      await stakingVault.fund({ value: amount });

      await stakingVault.connect(vaultOwner).lock(amount);

      await expect(stakingVault.connect(vaultOwner).lock(amount)).to.be.revertedWithCustomError(
        stakingVault,
        "NewLockedNotGreaterThanCurrent",
      );
    });

    it("reverts if the new locked amount exceeds the valuation", async () => {
      const amount = ether("1");
      await stakingVault.fund({ value: amount });

      await expect(stakingVault.connect(vaultOwner).lock(amount + 1n)).to.be.revertedWithCustomError(
        stakingVault,
        "NewLockedExceedsValuation",
      );
    });
  });

  context("rebalance", () => {
    beforeEach(async () => {
      await stakingVault.authorizeLidoVaultHub();
    });

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

    it("not reverts if the caller is vaultHub, but vaultHub is authorized", async () => {
      await stakingVault.fund({ value: ether("2") });

      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);

      await expect(stakingVault.rebalance(ether("1")))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(vaultOwnerAddress, vaultHubAddress, ether("1"))
        .to.emit(vaultHub, "Mock__Rebalanced")
        .withArgs(stakingVaultAddress, ether("1"));
    });

    it("reverts if the caller is vaultHub, but vaultHub is deauthorized", async () => {
      await stakingVault.fund({ value: ether("2") });

      await stakingVault.deauthorizeLidoVaultHub();
      expect(await stakingVault.vaultHubAuthorized()).to.equal(false);

      await expect(stakingVault.connect(vaultHubSigner).rebalance(ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("rebalance", vaultHubSigner);
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
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("0.1"), ether("1.1"));
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
    beforeEach(async () => {
      await stakingVault.authorizeLidoVaultHub();
    });

    it("reverts if the caller is not the vault hub", async () => {
      await expect(stakingVault.connect(stranger).report(0n, ether("1"), ether("2"), ether("3")))
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("report", stranger);
    });

    it("reverts if the caller is the vault hub, but vaultHub is deauthorized", async () => {
      await stakingVault.deauthorizeLidoVaultHub();
      expect(await stakingVault.vaultHubAuthorized()).to.equal(false);

      await expect(
        stakingVault
          .connect(vaultHubSigner)
          .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3")),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("report", vaultHubSigner);
    });

    it("updates the state and emits the Reported event", async () => {
      const timestamp = await getCurrentBlockTimestamp();
      await expect(stakingVault.connect(vaultHubSigner).report(timestamp, ether("1"), ether("2"), ether("3")))
        .to.emit(stakingVault, "Reported")
        .withArgs(timestamp, ether("1"), ether("2"), ether("3"));

      expect(await stakingVault.latestReport()).to.deep.equal([ether("1"), ether("2"), timestamp]);
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
    it("reverts if called by a non-depositor", async () => {
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
      const timestamp = await getCurrentBlockTimestamp();
      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault.connect(vaultHubSigner).report(timestamp, ether("0"), ether("0"), ether("1"));

      await expect(
        stakingVault
          .connect(depositor)
          .depositToBeaconChain([
            { pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") },
          ]),
      ).to.be.revertedWithCustomError(stakingVault, "ValuationBelowLockedAmount");
    });

    it("reverts if the deposits are paused", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();
      await expect(
        stakingVault
          .connect(depositor)
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
        stakingVault.connect(depositor).depositToBeaconChain([{ pubkey, signature, amount, depositDataRoot }]),
      )
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(depositor, 1, amount);
    });

    it("makes multiple deposits to the beacon chain and emits the `DepositedToBeaconChain` event", async () => {
      const numberOfKeys = 300; // number because of Array.from
      const totalAmount = ether("32") * BigInt(numberOfKeys);
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();

      // topup the contract with enough ETH to cover the deposits
      await setBalance(stakingVaultAddress, ether("32") * BigInt(numberOfKeys));

      const deposits = Array.from({ length: numberOfKeys }, () => {
        const validator = generateValidator(withdrawalCredentials);
        return generatePostDeposit(validator.container, ether("32"));
      });

      await expect(stakingVault.connect(depositor).depositToBeaconChain(deposits))
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(depositor, numberOfKeys, totalAmount);
    });
  });

  context("calculateValidatorWithdrawalFee", () => {
    it("reverts if the number of validators is zero", async () => {
      await expect(stakingVault.calculateValidatorWithdrawalFee(0))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_numberOfKeys");
    });

    it("works with max uint256", async () => {
      const fee = BigInt(await withdrawalRequestContract.fee());
      expect(await stakingVault.calculateValidatorWithdrawalFee(MAX_UINT256)).to.equal(BigInt(MAX_UINT256) * fee);
    });

    it("calculates the total fee for given number of validator keys", async () => {
      const newFee = 100n;
      await withdrawalRequestContract.mock__setFee(newFee);

      const fee = await stakingVault.calculateValidatorWithdrawalFee(1n);
      expect(fee).to.equal(newFee);

      const feePerRequest = await withdrawalRequestContract.fee();
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
      await expect(stakingVault.connect(vaultOwner).requestValidatorExit(INVALID_PUBKEY)).to.be.revertedWithCustomError(
        stakingVault,
        "InvalidPubkeysLength",
      );
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
      baseFee = BigInt(await withdrawalRequestContract.fee());
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

    it("reverts if the invalid pubkey is provided", async () => {
      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3"));

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(INVALID_PUBKEY, [ether("1")], vaultOwnerAddress, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingVault, "MalformedPubkeysArray");
    });

    it("reverts if called by a non-owner or the node operator", async () => {
      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3"));

      await expect(
        stakingVault
          .connect(stranger)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], vaultOwnerAddress, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("triggerValidatorWithdrawal", stranger);
    });

    it("reverts if called by the vault hub on a healthy vault", async () => {
      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3"));

      await expect(
        stakingVault
          .connect(vaultHubSigner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], vaultOwnerAddress, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("triggerValidatorWithdrawal", vaultHubAddress);
    });

    it("reverts if called by the vault hub with non fresh report with valuation > locked", async () => {
      await stakingVault.authorizeLidoVaultHub(); // needed for the report

      await expect(
        stakingVault
          .connect(vaultHubSigner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [0], vaultOwnerAddress, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("triggerValidatorWithdrawal", vaultHubAddress);
    });

    it("reverts if the amounts array is not the same length as the pubkeys array", async () => {
      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1"), ether("2")], vaultOwnerAddress, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingVault, "MismatchedArrayLengths");
    });

    it("reverts if the fee is less than the required fee", async () => {
      const numberOfKeys = 4;
      const pubkeys = getPubkeys(numberOfKeys);
      const amounts = Array(numberOfKeys).fill(ether("1"));
      const value = baseFee * BigInt(numberOfKeys) - 1n;

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3"));

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

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3"));

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
      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("0.9"), ether("1"), ether("1.1")); // slashing

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
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
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
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
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
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, SAMPLE_PUBKEY, [0n], vaultOwnerAddress, 0n);
    });

    it("requests a partial validator withdrawal", async () => {
      const amount = ether("0.1");

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3"));

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [amount], vaultOwnerAddress, { value: baseFee }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, amount), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, SAMPLE_PUBKEY, [amount], vaultOwnerAddress, 0);
    });

    it("requests a partial validator withdrawal and refunds the excess fee to the msg.sender if the refund recipient is the zero address", async () => {
      const amount = ether("0.1");
      const overpaid = 100n;

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3"));

      const ownerBalanceBefore = await ethers.provider.getBalance(vaultOwner);

      const tx = await stakingVault
        .connect(vaultOwner)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [amount], ZeroAddress, { value: baseFee + overpaid });

      await expect(tx)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, amount), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, SAMPLE_PUBKEY, [amount], vaultOwnerAddress, overpaid);

      const txReceipt = (await tx.wait()) as ContractTransactionReceipt;
      const gasFee = txReceipt.gasPrice * txReceipt.cumulativeGasUsed;

      const ownerBalanceAfter = await ethers.provider.getBalance(vaultOwner);

      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore - baseFee - gasFee); // overpaid is refunded back
    });

    it("requests a multiple validator withdrawals", async () => {
      const numberOfKeys = 300;
      const pubkeys = getPubkeys(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys);
      const amounts = Array(numberOfKeys)
        .fill(0)
        .map((_, i) => BigInt(i * 100)); // trigger full and partial withdrawals

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("1"), ether("2"), ether("3"));

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawal(pubkeys.stringified, amounts, vaultOwnerAddress, { value }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], amounts[0]), baseFee)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
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
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], amounts[0]), baseFee)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[1], amounts[1]), baseFee)
        .and.to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(vaultOwner, pubkeys.stringified, amounts, stranger, valueToRefund);

      const strangerBalanceAfter = await ethers.provider.getBalance(stranger);
      expect(strangerBalanceAfter).to.equal(strangerBalanceBefore + valueToRefund);
    });

    it("requests a validator withdrawal if called by the vault hub on an unhealthy vault", async () => {
      await stakingVault.fund({ value: ether("1") });

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault
        .connect(vaultHubSigner)
        .report(await getCurrentBlockTimestamp(), ether("0.9"), ether("1"), ether("1.1")); // slashing

      await expect(
        stakingVault
          .connect(vaultHubSigner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [0n], vaultOwnerAddress, { value: 1n }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee);
    });

    it("requests a validator withdrawal if called by the vault hub, when vaultHub is deauthorized", async () => {
      await stakingVault.fund({ value: ether("1") });
      const timestamp = await getCurrentBlockTimestamp();

      await stakingVault.authorizeLidoVaultHub(); // needed for the report
      await stakingVault.connect(vaultHubSigner).report(timestamp, ether("1"), ether("1"), ether("1.1")); // slashing

      await stakingVault.deauthorizeLidoVaultHub();
      expect(await stakingVault.vaultHubAuthorized()).to.equal(false);

      await expect(
        stakingVault
          .connect(vaultHubSigner)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [0n], vaultOwnerAddress, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("triggerValidatorWithdrawal", vaultHubSigner);
    });
  });
});
