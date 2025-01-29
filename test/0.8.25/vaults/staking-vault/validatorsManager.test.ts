import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  EIP7002WithdrawalRequest_Mock,
  StakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import { computeDepositDataRoot, de0x, ether, impersonate } from "lib";

import { deployStakingVaultBehindBeaconProxy } from "test/deploy";
import { EIP7002_PREDEPLOYED_ADDRESS, Snapshot } from "test/suite";

const getPubkey = (index: number) => index.toString(16).padStart(4, "0").toLocaleLowerCase().repeat(24);
const getSignature = (index: number) => index.toString(16).padStart(8, "0").toLocaleLowerCase().repeat(12);

const getPubkeys = (num: number) => `0x${Array.from({ length: num }, (_, i) => getPubkey(i + 1)).join("")}`;

describe("ValidatorsManager.sol", () => {
  let vaultOwner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultHubSigner: HardhatEthersSigner;

  let stakingVault: StakingVault;
  let vaultHub: VaultHub__MockForStakingVault;
  let depositContract: DepositContract__MockForStakingVault;
  let withdrawalRequest: EIP7002WithdrawalRequest_Mock;

  let vaultOwnerAddress: string;
  let vaultHubAddress: string;
  let operatorAddress: string;
  let depositContractAddress: string;
  let stakingVaultAddress: string;

  let originalState: string;

  before(async () => {
    [vaultOwner, operator, stranger] = await ethers.getSigners();
    ({ stakingVault, vaultHub, depositContract } = await deployStakingVaultBehindBeaconProxy(vaultOwner, operator));

    vaultOwnerAddress = await vaultOwner.getAddress();
    vaultHubAddress = await vaultHub.getAddress();
    operatorAddress = await operator.getAddress();
    depositContractAddress = await depositContract.getAddress();
    stakingVaultAddress = await stakingVault.getAddress();

    withdrawalRequest = await ethers.getContractAt("EIP7002WithdrawalRequest_Mock", EIP7002_PREDEPLOYED_ADDRESS);

    vaultHubSigner = await impersonate(vaultHubAddress, ether("10"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts if the deposit contract address is zero", async () => {
      await expect(ethers.deployContract("StakingVault", [vaultHubAddress, ZeroAddress])).to.be.revertedWithCustomError(
        stakingVault,
        "ZeroBeaconChainDepositContract",
      );
    });
  });

  context("_getDepositContract", () => {
    it("returns the deposit contract address", async () => {
      expect(await stakingVault.depositContract()).to.equal(depositContractAddress);
    });
  });

  context("_withdrawalCredentials", () => {
    it("returns the withdrawal credentials", async () => {
      expect(await stakingVault.withdrawalCredentials()).to.equal(
        ("0x01" + "00".repeat(11) + de0x(stakingVaultAddress)).toLowerCase(),
      );
    });
  });

  context("_depositToBeaconChain", () => {
    it("makes deposits to the beacon chain and emits the DepositedToBeaconChain event", async () => {
      const numberOfKeys = 2; // number because of Array.from
      const totalAmount = ether("32") * BigInt(numberOfKeys);
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();

      await stakingVault.fund({ value: totalAmount });

      const deposits = Array.from({ length: numberOfKeys }, (_, i) => {
        const pubkey = `0x${getPubkey(i + 1)}`;
        const signature = `0x${getSignature(i + 1)}`;
        const amount = ether("32");
        const depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);
        return { pubkey, signature, amount, depositDataRoot };
      });

      await expect(stakingVault.connect(operator).depositToBeaconChain(deposits))
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(operator, 2, totalAmount);
    });
  });

  context("_calculateTotalExitRequestFee", () => {
    it("returns the total fee for given number of validator keys", async () => {
      const newFee = 100n;
      await withdrawalRequest.setFee(newFee);

      const fee = await stakingVault.calculateTotalExitRequestFee(1n);
      expect(fee).to.equal(newFee);

      const feePerRequest = await withdrawalRequest.fee();
      expect(fee).to.equal(feePerRequest);

      const feeForMultipleKeys = await stakingVault.calculateTotalExitRequestFee(2n);
      expect(feeForMultipleKeys).to.equal(newFee * 2n);
    });
  });

  context("_requestValidatorsExit", () => {
    it("reverts if passed fee is less than the required fee", async () => {
      const numberOfKeys = 4;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await stakingVault.calculateTotalExitRequestFee(numberOfKeys - 1);

      await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee }))
        .to.be.revertedWithCustomError(stakingVault, "InsufficientExitFee")
        .withArgs(fee, numberOfKeys);
    });

    it("allows owner to request validators exit providing a fee", async () => {
      const numberOfKeys = 1;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await stakingVault.calculateTotalExitRequestFee(numberOfKeys);

      await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee }))
        .to.emit(stakingVault, "ValidatorsExitRequested")
        .withArgs(vaultOwnerAddress, pubkeys);
    });

    it("refunds the fee if passed fee is greater than the required fee", async () => {
      const numberOfKeys = 1;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await stakingVault.calculateTotalExitRequestFee(numberOfKeys);
      const overpaid = 100n;

      await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee + overpaid }))
        .to.emit(stakingVault, "ValidatorsExitRequested")
        .withArgs(vaultOwnerAddress, pubkeys)
        .and.to.emit(stakingVault, "ExitFeeRefunded")
        .withArgs(vaultOwnerAddress, overpaid);
    });

    context.skip("vault is balanced", () => {
      it("reverts if called by a non-owner or non-node operator", async () => {
        const keys = getValidatorPubkey(1);
        await expect(stakingVault.connect(stranger).requestValidatorsExit(keys))
          .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
          .withArgs(await stranger.getAddress());
      });

      it("reverts if passed fee is less than the required fee", async () => {
        const numberOfKeys = 4;
        const pubkeys = getValidatorPubkey(numberOfKeys);
        const fee = await stakingVault.calculateTotalExitRequestFee(numberOfKeys - 1);

        await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee }))
          .to.be.revertedWithCustomError(stakingVault, "InsufficientExitFee")
          .withArgs(fee, numberOfKeys);
      });

      it("allows owner to request validators exit providing a fee", async () => {
        const numberOfKeys = 1;
        const pubkeys = getValidatorPubkey(numberOfKeys);
        const fee = await stakingVault.calculateTotalExitRequestFee(numberOfKeys);

        await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee }))
          .to.emit(stakingVault, "ValidatorsExitRequested")
          .withArgs(vaultOwnerAddress, pubkeys);
      });

      it("allows node operator to request validators exit", async () => {
        const numberOfKeys = 1;
        const pubkeys = getValidatorPubkey(numberOfKeys);
        const fee = await stakingVault.calculateTotalExitRequestFee(numberOfKeys);

        await expect(stakingVault.connect(operator).requestValidatorsExit(pubkeys, { value: fee }))
          .to.emit(stakingVault, "ValidatorsExitRequested")
          .withArgs(operatorAddress, pubkeys);
      });

      it("works with multiple pubkeys", async () => {
        const numberOfKeys = 2;
        const pubkeys = getValidatorPubkey(numberOfKeys);
        const fee = await stakingVault.calculateTotalExitRequestFee(numberOfKeys);

        await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee }))
          .to.emit(stakingVault, "ValidatorsExitRequested")
          .withArgs(vaultOwnerAddress, pubkeys);
      });
    });

    context.skip("vault is unbalanced", () => {
      beforeEach(async () => {
        await stakingVault.connect(vaultHubSigner).report(ether("1"), ether("0.1"), ether("1.1"));
        expect(await stakingVault.isBalanced()).to.be.false;
      });

      it("reverts if timelocked", async () => {
        await expect(stakingVault.requestValidatorsExit("0x")).to.be.revertedWithCustomError(
          stakingVault,
          "ExitTimelockNotElapsed",
        );
      });
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
