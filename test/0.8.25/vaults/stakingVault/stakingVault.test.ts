import { expect } from "chai";
import { toChecksumAddress } from "ethereumjs-util";
import { ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  EIP7002WithdrawalRequest__Mock,
  EthRejector,
  StakingVault,
  StakingVault__factory,
  WETH9__MockForVault,
} from "typechain-types";

import {
  certainAddress,
  computeDepositDataRoot,
  de0x,
  EIP7002_MIN_WITHDRAWAL_REQUEST_FEE,
  ether,
  MAX_UINT256,
  ONE_GWEI,
  proxify,
  randomAddress,
  streccak,
} from "lib";
import { getPubkeys } from "lib/protocol";

import { deployEIP7002WithdrawalRequestContractMock } from "test/0.8.9/withdrawalVault/eip7002Mock";
import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);
const INVALID_PUBKEY = "0x" + "ab".repeat(47);

const encodeEip7002Input = (pubkey: string, amount: bigint): string => {
  return `${pubkey}${amount.toString(16).padStart(16, "0")}`;
};

describe("StakingVault.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let depositor: HardhatEthersSigner;

  let stakingVault: StakingVault;
  let stakingVaultImplementation: StakingVault;
  let depositContract: DepositContract__MockForStakingVault;
  let withdrawalRequestContract: EIP7002WithdrawalRequest__Mock;
  let weth: WETH9__MockForVault;
  let ethRejector: EthRejector;

  let originalState: string;

  before(async () => {
    [deployer, vaultOwner, operator, depositor, stranger] = await ethers.getSigners();
    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");

    stakingVaultImplementation = await ethers.deployContract("StakingVault", [depositContract]);
    expect(await stakingVaultImplementation.DEPOSIT_CONTRACT()).to.equal(depositContract);
    expect(await stakingVaultImplementation.version()).to.equal(1);

    weth = await ethers.deployContract("WETH9__MockForVault");
    const beacon = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImplementation, deployer]);
    const beaconProxy = await ethers.deployContract("PinnedBeaconProxy", [beacon, "0x"]);
    stakingVault = StakingVault__factory.connect(await beaconProxy.getAddress(), vaultOwner);

    await expect(stakingVault.initialize(vaultOwner, operator, depositor))
      .to.emit(stakingVault, "OwnershipTransferred")
      .withArgs(ZeroAddress, vaultOwner)
      .to.emit(stakingVault, "DepositorSet")
      .withArgs(ZeroAddress, depositor)
      .to.emit(stakingVault, "NodeOperatorSet")
      .withArgs(operator);

    expect(await stakingVault.owner()).to.equal(vaultOwner);
    expect(await stakingVault.depositor()).to.equal(depositor);
    expect(await stakingVault.nodeOperator()).to.equal(operator);
    expect(await stakingVault.version()).to.equal(1);
    expect(await stakingVault.getInitializedVersion()).to.equal(1);
    expect(await stakingVault.pendingOwner()).to.equal(ZeroAddress);
    expect(toChecksumAddress(await stakingVault.withdrawalCredentials())).to.equal(
      toChecksumAddress("0x02" + "00".repeat(11) + de0x(await stakingVault.getAddress())),
    );

    withdrawalRequestContract = await deployEIP7002WithdrawalRequestContractMock(EIP7002_MIN_WITHDRAWAL_REQUEST_FEE);

    ethRejector = await ethers.deployContract("EthRejector");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("sets the deposit contract address in the implementation", async () => {
      expect(await stakingVaultImplementation.DEPOSIT_CONTRACT()).to.equal(depositContract);
    });

    it("reverts on construction if the deposit contract address is zero", async () => {
      await expect(ethers.deployContract("StakingVault", [ZeroAddress]))
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
        stakingVaultImplementation.connect(stranger).initialize(vaultOwner, operator, depositor),
      ).to.be.revertedWithCustomError(stakingVaultImplementation, "InvalidInitialization");
    });

    it("reverts if the node operator is zero address", async () => {
      const [vault_] = await proxify({ impl: stakingVaultImplementation, admin: vaultOwner });
      await expect(vault_.initialize(vaultOwner, ZeroAddress, depositor))
        .to.be.revertedWithCustomError(stakingVaultImplementation, "ZeroArgument")
        .withArgs("_nodeOperator");
    });

    it("reverts if the depositor is zero address", async () => {
      const [vault_] = await proxify({ impl: stakingVaultImplementation, admin: vaultOwner });
      await expect(vault_.initialize(vaultOwner, operator, ZeroAddress))
        .to.be.revertedWithCustomError(stakingVaultImplementation, "ZeroArgument")
        .withArgs("_depositor");
    });
  });

  context("initial state (getters)", () => {
    it("returns the correct initial state and constants", async () => {
      expect(await stakingVault.DEPOSIT_CONTRACT()).to.equal(depositContract);
      expect(await stakingVault.owner()).to.equal(await vaultOwner.getAddress());
      expect(await stakingVault.getInitializedVersion()).to.equal(1n);
      expect(await stakingVault.version()).to.equal(1n);
      expect(await stakingVault.nodeOperator()).to.equal(operator);
      expect(toChecksumAddress(await stakingVault.withdrawalCredentials())).to.equal(
        toChecksumAddress("0x02" + "00".repeat(11) + de0x(await stakingVault.getAddress())),
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  context("ossify", () => {
    it("reverts on stranger", async () => {
      await expect(stakingVault.connect(stranger).ossify())
        .to.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(stranger);
    });

    it("reverts on already ossified", async () => {
      await stakingVault.ossify();

      await expect(stakingVault.ossify()).to.revertedWithCustomError(stakingVault, "AlreadyOssified");
    });

    it("ossifies the vault", async () => {
      await expect(stakingVault.ossify()).to.emit(stakingVault, "PinnedImplementationUpdated");
    });
  });

  context("depositor", () => {
    it("returns the correct depositor", async () => {
      expect(await stakingVault.depositor()).to.equal(depositor);
    });

    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).setDepositor(depositor))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(stranger);
    });

    it("reverts if the depositor is zero address", async () => {
      await expect(stakingVault.connect(vaultOwner).setDepositor(ZeroAddress))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_depositor");
    });

    it("reverts if the new depositor is the same as the previous depositor", async () => {
      await expect(stakingVault.connect(vaultOwner).setDepositor(depositor)).to.be.revertedWithCustomError(
        stakingVault,
        "NewDepositorSameAsPrevious",
      );
    });

    it("sets the depositor", async () => {
      const newDepositor = certainAddress("new-depositor");

      await expect(stakingVault.connect(vaultOwner).setDepositor(newDepositor))
        .to.emit(stakingVault, "DepositorSet")
        .withArgs(depositor, newDepositor);

      expect(await stakingVault.depositor()).to.equal(newDepositor);
    });
  });

  context("receive", () => {
    it("accepts ether", async () => {
      const amount = ether("1");
      await expect(vaultOwner.sendTransaction({ to: stakingVault, value: amount })).to.changeEtherBalance(
        stakingVault,
        amount,
      );
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

    it("accepts ether", async () => {
      const amount = ether("1");
      await expect(stakingVault.fund({ value: amount })).to.changeEtherBalance(stakingVault, amount);
    });
  });

  context("withdraw", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).withdraw(vaultOwner, ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("reverts if the recipient is the zero address", async () => {
      await expect(stakingVault.withdraw(ZeroAddress, ether("1")))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("reverts if the amount is zero", async () => {
      await expect(stakingVault.withdraw(vaultOwner, 0n))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_ether");
    });

    it("reverts if insufficient balance", async () => {
      const balance = await ethers.provider.getBalance(stakingVault);

      const amount = balance + 1n;
      await expect(stakingVault.withdraw(vaultOwner, amount))
        .to.be.revertedWithCustomError(stakingVault, "InsufficientBalance")
        .withArgs(balance, amount);
    });

    it("reverts if the recipient cannot receive ether", async () => {
      const amount = ether("1");
      await stakingVault.fund({ value: amount });

      await expect(stakingVault.withdraw(ethRejector, amount))
        .to.be.revertedWithCustomError(stakingVault, "TransferFailed")
        .withArgs(ethRejector, amount);
    });

    it("transfers the amount to the recipient", async () => {
      const amount = ether("1");
      await stakingVault.fund({ value: amount });

      const recipient = certainAddress("recipient");
      const tx = await stakingVault.withdraw(recipient, amount);
      await expect(tx).to.emit(stakingVault, "EtherWithdrawn").withArgs(recipient, amount);
      await expect(tx).to.changeEtherBalance(recipient, amount);
    });
  });

  context("withdrawalCredentials", () => {
    it("returns the correct withdrawal credentials in 0x02 format", async () => {
      const withdrawalCredentials = ("0x02" + "00".repeat(11) + de0x(await stakingVault.getAddress())).toLowerCase();
      expect(await stakingVault.withdrawalCredentials()).to.equal(withdrawalCredentials);
    });
  });

  context("beaconChainDepositsPaused", () => {
    it("returns the correct beacon chain deposits paused status", async () => {
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      await stakingVault.pauseBeaconChainDeposits();
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      await stakingVault.resumeBeaconChainDeposits();
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
      await stakingVault.pauseBeaconChainDeposits();

      await expect(stakingVault.pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsAlreadyPaused",
      );
    });

    it("allows to pause deposits", async () => {
      await expect(stakingVault.pauseBeaconChainDeposits()).to.emit(stakingVault, "BeaconChainDepositsPaused");
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
      await expect(stakingVault.resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsAlreadyResumed",
      );
    });

    it("allows to resume deposits", async () => {
      await stakingVault.pauseBeaconChainDeposits();

      await expect(stakingVault.resumeBeaconChainDeposits()).to.emit(stakingVault, "BeaconChainDepositsResumed");
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  context("renounceOwnership", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).renounceOwnership())
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(stranger);
    });

    it("reverts if called by the owner", async () => {
      await expect(stakingVault.connect(vaultOwner).renounceOwnership()).to.be.revertedWithCustomError(
        stakingVault,
        "RenouncementNotAllowed",
      );
    });
  });

  context("depositToBeaconChain", () => {
    it("reverts if called by a non-depositor", async () => {
      await expect(
        stakingVault
          .connect(stranger)
          .depositToBeaconChain({ pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") }),
      ).to.be.revertedWithCustomError(stakingVault, "SenderNotDepositor");
    });

    it("reverts if the total amount of deposits exceeds the vault's balance", async () => {
      await stakingVault.fund({ value: ether("1") });

      await expect(
        stakingVault.connect(depositor).depositToBeaconChain({
          pubkey: "0x",
          signature: "0x",
          amount: ether("2"),
          depositDataRoot: streccak("random-root"),
        }),
      )
        .to.be.revertedWithCustomError(stakingVault, "InsufficientBalance")
        .withArgs(ether("1"), ether("2"));
    });

    it("reverts if the deposits are paused", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();
      await expect(
        stakingVault
          .connect(depositor)
          .depositToBeaconChain({ pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") }),
      ).to.be.revertedWithCustomError(stakingVault, "BeaconChainDepositsOnPause");
    });

    it("makes deposits to the beacon chain", async () => {
      await stakingVault.fund({ value: ether("32") });

      const pubkey = "0x" + "ab".repeat(48);
      const signature = "0x" + "ef".repeat(96);
      const amount = ether("32");
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);

      await expect(stakingVault.connect(depositor).depositToBeaconChain({ pubkey, signature, amount, depositDataRoot }))
        .to.emit(depositContract, "DepositEvent")
        .withArgs(pubkey, withdrawalCredentials, signature, depositDataRoot);
    });
  });

  context("calculateValidatorWithdrawalFee", () => {
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
      await expect(stakingVault.requestValidatorExit(SAMPLE_PUBKEY))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(SAMPLE_PUBKEY, SAMPLE_PUBKEY);
    });

    it("emits the exact number of `ValidatorExitRequested` events as the number of validator keys", async () => {
      const numberOfKeys = 2;
      const keys = getPubkeys(numberOfKeys);

      const tx = await stakingVault.requestValidatorExit(keys.stringified);
      await expect(tx.wait())
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(keys.pubkeys[0], keys.pubkeys[0])
        .and.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(keys.pubkeys[1], keys.pubkeys[1]);

      const receipt = (await tx.wait()) as ContractTransactionReceipt;
      expect(receipt.logs.length).to.equal(numberOfKeys);
    });
  });

  context("triggerValidatorWithdrawals", () => {
    let baseFee: bigint;

    before(async () => {
      baseFee = BigInt(await withdrawalRequestContract.fee());
    });

    it("reverts if msg.value is zero", async () => {
      await expect(stakingVault.triggerValidatorWithdrawals("0x", [], vaultOwner))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if the number of validators is zero", async () => {
      await expect(stakingVault.triggerValidatorWithdrawals("0x", [], vaultOwner, { value: 1n }))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_pubkeys");
    });

    it("triggers full validator withdrawals if the amounts array is empty", async () => {
      await expect(stakingVault.triggerValidatorWithdrawals(SAMPLE_PUBKEY, [], vaultOwner, { value: 1n }))
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [], 0n, vaultOwner);
    });

    it("reverts if the invalid pubkey is provided", async () => {
      await expect(
        stakingVault.triggerValidatorWithdrawals(INVALID_PUBKEY, [], vaultOwner, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingVault, "InvalidPubkeysLength");
    });

    it("reverts if the refund recipient is the zero address", async () => {
      await expect(stakingVault.triggerValidatorWithdrawals(SAMPLE_PUBKEY, [], ZeroAddress, { value: 1n }))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_excessRefundRecipient");
    });

    it("reverts if called by a non-owner", async () => {
      await expect(
        stakingVault.connect(stranger).triggerValidatorWithdrawals(SAMPLE_PUBKEY, [], vaultOwner, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(stranger);
    });

    it("reverts if the amounts array is not the same length as the pubkeys array", async () => {
      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [ether("1"), ether("2")], vaultOwner, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingVault, "MismatchedArrayLengths");
    });

    it("reverts if the fee is less than the required fee", async () => {
      const numberOfKeys = 4;
      const pubkeys = getPubkeys(numberOfKeys);
      const amounts = Array(numberOfKeys).fill(ether("1"));
      const value = baseFee * BigInt(numberOfKeys) - 1n;

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(pubkeys.stringified, amounts, vaultOwner, { value }),
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
          .triggerValidatorWithdrawals(pubkeys.stringified, [ether("1")], ethRejector, { value }),
      )
        .to.be.revertedWithCustomError(stakingVault, "TransferFailed")
        .withArgs(ethRejector, overpaid);
    });

    it("requests a validator withdrawal when called by the owner", async () => {
      const value = baseFee;

      await expect(
        stakingVault.connect(vaultOwner).triggerValidatorWithdrawals(SAMPLE_PUBKEY, [0n], vaultOwner, { value }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [0n], 0n, vaultOwner);
    });

    it("requests a full validator withdrawal", async () => {
      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [0n], vaultOwner, { value: baseFee }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [0n], 0n, vaultOwner);
    });

    it("requests a partial validator withdrawal", async () => {
      const amount = ether("0.1");

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [amount], vaultOwner, { value: baseFee }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, amount), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [amount], 0n, vaultOwner);
    });

    it("requests a partial validator withdrawal and refunds the excess", async () => {
      const amount = ether("0.1");
      const overpaid = 100n;
      const recipient = await randomAddress();

      const tx = await stakingVault
        .connect(vaultOwner)
        .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [amount], recipient, { value: baseFee + overpaid });

      await expect(tx)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, amount), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [amount], overpaid, recipient);

      const recipientBalance = await ethers.provider.getBalance(recipient);
      expect(recipientBalance).to.equal(overpaid);
    });

    it("requests a multiple validator withdrawals", async () => {
      const numberOfKeys = 300;
      const pubkeys = getPubkeys(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys);
      const amounts = Array(numberOfKeys)
        .fill(0)
        .map((_, i) => BigInt(i * 100)); // trigger full and partial withdrawals

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(pubkeys.stringified, amounts, vaultOwner, { value }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], amounts[0]), baseFee)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[1], amounts[1]), baseFee)
        .and.to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(pubkeys.stringified, amounts, 0n, vaultOwner);
    });

    it("requests a multiple validator withdrawals and refunds the excess fee to the fee recipient", async () => {
      const numberOfKeys = 2;
      const pubkeys = getPubkeys(numberOfKeys);
      const amounts = Array(numberOfKeys).fill(0); // trigger full withdrawals
      const valueToRefund = 100n * BigInt(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys) + valueToRefund;

      const strangerBalanceBefore = await ethers.provider.getBalance(stranger);

      await expect(
        stakingVault.connect(vaultOwner).triggerValidatorWithdrawals(pubkeys.stringified, amounts, stranger, { value }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], amounts[0]), baseFee)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[1], amounts[1]), baseFee)
        .and.to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(pubkeys.stringified, amounts, valueToRefund, stranger);

      const strangerBalanceAfter = await ethers.provider.getBalance(stranger);
      expect(strangerBalanceAfter).to.equal(strangerBalanceBefore + valueToRefund);
    });

    it("requests a bigger than uin64 in wei partial validator withdrawal", async () => {
      let amount = ether("32");

      // NB: the amount field is uin64 so only works for Gwei, and should not work with Wei
      let gotError: boolean | undefined = undefined;
      try {
        await stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [amount], vaultOwner, { value: baseFee });
      } catch (error) {
        gotError = !!error;
      }
      expect(gotError).to.be.true;

      amount /= ONE_GWEI;

      await expect(
        stakingVault
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [amount], vaultOwner, { value: baseFee }),
      )
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, amount), baseFee)
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [amount], 0n, vaultOwner);
    });
  });

  context("ejectValidators", () => {
    let baseFee: bigint;

    before(async () => {
      baseFee = BigInt(await withdrawalRequestContract.fee());
    });
    it("reverts if msg.value is zero", async () => {
      await expect(stakingVault.ejectValidators("0x", vaultOwner))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if the number of validators is zero", async () => {
      await expect(stakingVault.ejectValidators("0x", vaultOwner, { value: 1n }))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_pubkeys");
    });

    it("reverts if the invalid pubkey is provided", async () => {
      await expect(
        stakingVault.ejectValidators(INVALID_PUBKEY, vaultOwner, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingVault, "InvalidPubkeysLength");
    });

    it("reverts if not called by the node operator", async () => {
      await expect(
        stakingVault.connect(stranger).ejectValidators(SAMPLE_PUBKEY, vaultOwner, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingVault, "SenderNotNodeOperator");
    });

    it("reverts if the fee is less than the required fee", async () => {
      const numberOfKeys = 4;
      const pubkeys = getPubkeys(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys) - 1n;

      await expect(stakingVault.connect(operator).ejectValidators(pubkeys.stringified, operator, { value }))
        .to.be.revertedWithCustomError(stakingVault, "InsufficientValidatorWithdrawalFee")
        .withArgs(value, baseFee * BigInt(numberOfKeys));
    });

    it("refunds the excess to the sender if the refund recipient is the zero address", async () => {
      const numberOfKeys = 1;
      const overpaid = 100n;
      const pubkeys = getPubkeys(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys) + overpaid;

      const tx = await stakingVault.connect(operator).ejectValidators(pubkeys.stringified, ZeroAddress, { value });

      await expect(tx)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], 0n), baseFee)
        .to.emit(stakingVault, "ValidatorEjectionsTriggered")
        .withArgs(pubkeys.stringified, overpaid, operator);
    });

    it("reverts if the refund fails", async () => {
      const numberOfKeys = 1;
      const overpaid = 100n;
      const pubkeys = getPubkeys(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys) + overpaid;

      await expect(stakingVault.connect(operator).ejectValidators(pubkeys.stringified, ethRejector, { value }))
        .to.be.revertedWithCustomError(stakingVault, "TransferFailed")
        .withArgs(ethRejector, overpaid);
    });

    it("requests a validator exit when called by the node operator", async () => {
      const value = baseFee;

      await expect(stakingVault.connect(operator).ejectValidators(SAMPLE_PUBKEY, operator, { value }))
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee)
        .to.emit(stakingVault, "ValidatorEjectionsTriggered")
        .withArgs(SAMPLE_PUBKEY, 0n, operator);
    });

    it("requests a full validator exit", async () => {
      await expect(stakingVault.connect(operator).ejectValidators(SAMPLE_PUBKEY, operator, { value: baseFee }))
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(SAMPLE_PUBKEY, 0n), baseFee)
        .to.emit(stakingVault, "ValidatorEjectionsTriggered")
        .withArgs(SAMPLE_PUBKEY, 0n, operator);
    });

    it("requests a multiple validator exits", async () => {
      const numberOfKeys = 300;
      const pubkeys = getPubkeys(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys);

      await expect(stakingVault.connect(operator).ejectValidators(pubkeys.stringified, operator, { value }))
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], 0n), baseFee)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[1], 0n), baseFee)
        .and.to.emit(stakingVault, "ValidatorEjectionsTriggered")
        .withArgs(pubkeys.stringified, 0n, operator);
    });

    it("requests a multiple validator exits and refunds the excess fee to the fee recipient", async () => {
      const numberOfKeys = 2;
      const pubkeys = getPubkeys(numberOfKeys);
      const valueToRefund = 100n * BigInt(numberOfKeys);
      const value = baseFee * BigInt(numberOfKeys) + valueToRefund;

      const strangerBalanceBefore = await ethers.provider.getBalance(stranger);

      await expect(stakingVault.connect(operator).ejectValidators(pubkeys.stringified, stranger, { value }))
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[0], 0n), baseFee)
        .to.emit(withdrawalRequestContract, "RequestAdded__Mock")
        .withArgs(encodeEip7002Input(pubkeys.pubkeys[1], 0n), baseFee)
        .and.to.emit(stakingVault, "ValidatorEjectionsTriggered")
        .withArgs(pubkeys.stringified, valueToRefund, stranger);

      const strangerBalanceAfter = await ethers.provider.getBalance(stranger);
      expect(strangerBalanceAfter).to.equal(strangerBalanceBefore + valueToRefund);
    });
  });

  context("2-step ownership", () => {
    it("can be transferred", async () => {
      await expect(stakingVault.connect(vaultOwner).transferOwnership(stranger))
        .to.emit(stakingVault, "OwnershipTransferStarted")
        .withArgs(vaultOwner, stranger);

      expect(await stakingVault.owner()).to.equal(vaultOwner);
      expect(await stakingVault.pendingOwner()).to.equal(stranger);
    });

    it("can be accepted", async () => {
      await stakingVault.connect(vaultOwner).transferOwnership(stranger);

      await expect(stakingVault.connect(stranger).acceptOwnership())
        .to.emit(stakingVault, "OwnershipTransferred")
        .withArgs(vaultOwner, stranger);

      expect(await stakingVault.owner()).to.equal(stranger);
    });
  });

  context("collect assets", () => {
    const amount = ether("1");

    beforeEach(async () => {
      await weth.connect(vaultOwner).deposit({ value: amount });
      await weth.connect(vaultOwner).transfer(stakingVault, amount);
      expect(await weth.balanceOf(stakingVault)).to.equal(amount);
    });

    it("allows only owner to collect assets", async () => {
      await expect(stakingVault.connect(stranger).collectERC20(weth, stranger, amount))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(stranger);
    });

    it('allows owner to collect "ERC20" assets', async () => {
      const tx = await stakingVault.connect(vaultOwner).collectERC20(weth, stranger, amount);
      const receipt = await tx.wait();

      await expect(receipt).to.emit(stakingVault, "AssetsRecovered").withArgs(stranger, weth, amount);

      expect(await weth.balanceOf(stakingVault)).to.equal(0);
      expect(await weth.balanceOf(stranger)).to.equal(amount);
    });

    it("reverts on zero args", async () => {
      const vault = stakingVault.connect(vaultOwner);
      await expect(vault.collectERC20(weth, ZeroAddress, amount))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_recipient");

      await expect(vault.collectERC20(ZeroAddress, stranger, amount))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_token");

      await expect(vault.collectERC20(weth, stranger, 0n))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_amount");
    });

    it("explicitly reverts on ether collection", async () => {
      const eth = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
      await expect(stakingVault.connect(vaultOwner).collectERC20(eth, stranger, amount))
        .to.be.revertedWithCustomError(stakingVault, "EthCollectionNotAllowed")
        .withArgs();
    });
  });
});
