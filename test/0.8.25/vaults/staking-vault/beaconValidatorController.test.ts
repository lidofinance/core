import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  BeaconValidatorController__Harness,
  DepositContract__MockForStakingVault,
  EIP7002WithdrawalRequest_Mock,
  EthRejector,
} from "typechain-types";

import { computeDepositDataRoot, de0x, ether, impersonate } from "lib";

import { deployWithdrawalsPreDeployedMock } from "test/deploy";
import { Snapshot } from "test/suite";

const getPubkey = (index: number) => index.toString(16).padStart(4, "0").toLocaleLowerCase().repeat(24);
const getSignature = (index: number) => index.toString(16).padStart(8, "0").toLocaleLowerCase().repeat(12);

const getPubkeys = (num: number) => `0x${Array.from({ length: num }, (_, i) => getPubkey(i + 1)).join("")}`;

describe("BeaconValidatorController.sol", () => {
  let owner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;

  let controller: BeaconValidatorController__Harness;
  let depositContract: DepositContract__MockForStakingVault;
  let withdrawalRequest: EIP7002WithdrawalRequest_Mock;
  let ethRejector: EthRejector;

  let depositContractAddress: string;
  let controllerAddress: string;

  let originalState: string;

  before(async () => {
    [owner, operator] = await ethers.getSigners();

    withdrawalRequest = await deployWithdrawalsPreDeployedMock(1n);
    ethRejector = await ethers.deployContract("EthRejector");

    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    depositContractAddress = await depositContract.getAddress();

    controller = await ethers.deployContract("BeaconValidatorController__Harness", [depositContractAddress]);
    controllerAddress = await controller.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts if the deposit contract address is zero", async () => {
      await expect(
        ethers.deployContract("BeaconValidatorController__Harness", [ZeroAddress]),
      ).to.be.revertedWithCustomError(controller, "ZeroBeaconChainDepositContract");
    });
  });

  context("_depositContract", () => {
    it("returns the deposit contract address", async () => {
      expect(await controller.harness__depositContract()).to.equal(depositContractAddress);
    });
  });

  context("_withdrawalCredentials", () => {
    it("returns the withdrawal credentials", async () => {
      expect(await controller.harness__withdrawalCredentials()).to.equal(
        ("0x02" + "00".repeat(11) + de0x(controllerAddress)).toLowerCase(),
      );
    });
  });

  context("_deposit", () => {
    it("makes deposits to the beacon chain and emits the Deposited event", async () => {
      const numberOfKeys = 2; // number because of Array.from
      const totalAmount = ether("32") * BigInt(numberOfKeys);
      const withdrawalCredentials = await controller.harness__withdrawalCredentials();

      // topup the contract with enough ETH to cover the deposits
      await setBalance(controllerAddress, ether("32") * BigInt(numberOfKeys));

      const deposits = Array.from({ length: numberOfKeys }, (_, i) => {
        const pubkey = `0x${getPubkey(i + 1)}`;
        const signature = `0x${getSignature(i + 1)}`;
        const amount = ether("32");
        const depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);
        return { pubkey, signature, amount, depositDataRoot };
      });

      await expect(controller.connect(operator).harness__deposit(deposits))
        .to.emit(controller, "Deposited")
        .withArgs(operator, 2, totalAmount);
    });
  });

  context("_calculateWithdrawalFee", () => {
    it("returns the total fee for given number of validator keys", async () => {
      const newFee = 100n;
      await withdrawalRequest.setFee(newFee);

      const fee = await controller.harness__calculateWithdrawalFee(1n);
      expect(fee).to.equal(newFee);

      const feePerRequest = await withdrawalRequest.fee();
      expect(fee).to.equal(feePerRequest);

      const feeForMultipleKeys = await controller.harness__calculateWithdrawalFee(2n);
      expect(feeForMultipleKeys).to.equal(newFee * 2n);
    });
  });

  context("_requestExit", () => {
    it("emits the ExitRequested event", async () => {
      const pubkeys = getPubkeys(2);
      await expect(controller.connect(owner).harness__requestExit(pubkeys))
        .to.emit(controller, "ExitRequested")
        .withArgs(owner, pubkeys);
    });
  });

  context("_initiateFullWithdrawal", () => {
    it("reverts if passed fee is less than the required fee", async () => {
      const numberOfKeys = 4;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await controller.harness__calculateWithdrawalFee(numberOfKeys - 1);

      await expect(controller.connect(owner).harness__initiateFullWithdrawal(pubkeys, { value: fee }))
        .to.be.revertedWithCustomError(controller, "InsufficientFee")
        .withArgs(fee, numberOfKeys);
    });

    it("reverts if the refund fails", async () => {
      const numberOfKeys = 1;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await controller.harness__calculateWithdrawalFee(numberOfKeys);
      const overpaid = 100n;

      const ethRejectorAddress = await ethRejector.getAddress();
      const ethRejectorSigner = await impersonate(ethRejectorAddress, ether("1"));

      await expect(
        controller.connect(ethRejectorSigner).harness__initiateFullWithdrawal(pubkeys, { value: fee + overpaid }),
      )
        .to.be.revertedWithCustomError(controller, "FeeRefundFailed")
        .withArgs(ethRejectorAddress, overpaid);
    });

    it("initiates full withdrawal providing a fee", async () => {
      const numberOfKeys = 1;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await controller.harness__calculateWithdrawalFee(numberOfKeys);

      await expect(controller.connect(owner).harness__initiateFullWithdrawal(pubkeys, { value: fee }))
        .to.emit(controller, "WithdrawalInitiated")
        .withArgs(owner, pubkeys);
    });

    it("refunds the fee if passed fee is greater than the required fee", async () => {
      const numberOfKeys = 1;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await controller.harness__calculateWithdrawalFee(numberOfKeys);
      const overpaid = 100n;

      await expect(controller.connect(owner).harness__initiateFullWithdrawal(pubkeys, { value: fee + overpaid }))
        .to.emit(controller, "WithdrawalInitiated")
        .withArgs(owner, pubkeys)
        .and.to.emit(controller, "FeeRefunded")
        .withArgs(owner, overpaid);
    });
  });

  context("_initiatePartialWithdrawal", () => {
    it("reverts if passed fee is less than the required fee", async () => {
      const numberOfKeys = 4;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await controller.harness__calculateWithdrawalFee(numberOfKeys - 1);

      await expect(controller.connect(owner).harness__initiatePartialWithdrawal(pubkeys, [100n, 200n], { value: fee }))
        .to.be.revertedWithCustomError(controller, "InsufficientFee")
        .withArgs(fee, numberOfKeys);
    });

    it("reverts if the refund fails", async () => {
      const numberOfKeys = 2;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await controller.harness__calculateWithdrawalFee(numberOfKeys);
      const overpaid = 100n;

      const ethRejectorAddress = await ethRejector.getAddress();
      const ethRejectorSigner = await impersonate(ethRejectorAddress, ether("1"));

      await expect(
        controller
          .connect(ethRejectorSigner)
          .harness__initiatePartialWithdrawal(pubkeys, [100n, 200n], { value: fee + overpaid }),
      )
        .to.be.revertedWithCustomError(controller, "FeeRefundFailed")
        .withArgs(ethRejectorAddress, overpaid);
    });

    it("initiates partial withdrawal providing a fee", async () => {
      const numberOfKeys = 2;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await controller.harness__calculateWithdrawalFee(numberOfKeys);

      await expect(controller.connect(owner).harness__initiatePartialWithdrawal(pubkeys, [100n, 200n], { value: fee }))
        .to.emit(controller, "PartialWithdrawalInitiated")
        .withArgs(owner, pubkeys, [100n, 200n]);
    });

    it("refunds the fee if passed fee is greater than the required fee", async () => {
      const numberOfKeys = 2;
      const pubkeys = getPubkeys(numberOfKeys);
      const fee = await controller.harness__calculateWithdrawalFee(numberOfKeys);
      const overpaid = 100n;

      await expect(
        controller.connect(owner).harness__initiatePartialWithdrawal(pubkeys, [100n, 200n], { value: fee + overpaid }),
      )
        .to.emit(controller, "PartialWithdrawalInitiated")
        .withArgs(owner, pubkeys, [100n, 200n])
        .and.to.emit(controller, "FeeRefunded")
        .withArgs(owner, overpaid);
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

      expect(
        await controller.harness__computeDepositDataRoot(pubkey, withdrawalCredentials, signature, amount),
      ).to.equal(expectedDepositDataRoot);
    });
  });
});
