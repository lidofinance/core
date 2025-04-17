import { expect } from "chai";
import { ContractTransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  EIP7002WithdrawalRequest__Mock,
  ERC20__Harness,
  ERC721__Harness,
  Lido__MockForWithdrawalVault,
  RefundFailureTester,
  WithdrawalVault__Harness,
} from "typechain-types";

import { deployEIP7002WithdrawalRequestContract, EIP7002_ADDRESS, MAX_UINT256, proxify, streccak } from "lib";

import { findEIP7002MockEvents, testEIP7002Mock } from "test/common/lib/triggerableWithdrawals/eip7002Mock";
import { generateWithdrawalRequestPayload } from "test/common/lib/triggerableWithdrawals/utils";
import { Snapshot } from "test/suite";

const PETRIFIED_VERSION = MAX_UINT256;

const ADD_FULL_WITHDRAWAL_REQUEST_ROLE = streccak("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
const ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE = streccak("ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE");

describe("WithdrawalVault.sol", () => {
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let validatorsExitBus: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  let lido: Lido__MockForWithdrawalVault;
  let lidoAddress: string;

  let withdrawalsPredeployed: EIP7002WithdrawalRequest__Mock;

  let impl: WithdrawalVault__Harness;
  let vault: WithdrawalVault__Harness;
  let vaultAddress: string;

  before(async () => {
    [owner, treasury, validatorsExitBus, stranger] = await ethers.getSigners();

    withdrawalsPredeployed = await deployEIP7002WithdrawalRequestContract(1n);

    expect(await withdrawalsPredeployed.getAddress()).to.equal(EIP7002_ADDRESS);

    lido = await ethers.deployContract("Lido__MockForWithdrawalVault");
    lidoAddress = await lido.getAddress();

    impl = await ethers.deployContract("WithdrawalVault__Harness", [lidoAddress, treasury.address], owner);

    [vault] = await proxify({ impl, admin: owner });
    vaultAddress = await vault.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constructor", () => {
    it("Reverts if the Lido address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [ZeroAddress, treasury.address]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the treasury address is zero", async () => {
      await expect(ethers.deployContract("WithdrawalVault", [lidoAddress, ZeroAddress])).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress",
      );
    });

    it("Sets initial properties", async () => {
      expect(await vault.LIDO()).to.equal(lidoAddress, "Lido address");
      expect(await vault.TREASURY()).to.equal(treasury.address, "Treasury address");
    });

    it("Petrifies the implementation", async () => {
      expect(await impl.getContractVersion()).to.equal(PETRIFIED_VERSION);
    });

    it("Returns 0 as the initial contract version", async () => {
      expect(await vault.getContractVersion()).to.equal(0n);
    });
  });

  context("initialize", () => {
    it("Should revert if the contract is already initialized", async () => {
      await vault.initialize(owner);

      await expect(vault.initialize(owner))
        .to.be.revertedWithCustomError(vault, "UnexpectedContractVersion")
        .withArgs(2, 0);
    });

    it("Initializes the contract", async () => {
      await expect(vault.initialize(owner)).to.emit(vault, "ContractVersionSet").withArgs(2);
    });

    it("Should revert if admin address is zero", async () => {
      await expect(vault.initialize(ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Should set admin role during initialization", async () => {
      const adminRole = await vault.DEFAULT_ADMIN_ROLE();
      expect(await vault.getRoleMemberCount(adminRole)).to.equal(0);
      expect(await vault.hasRole(adminRole, owner)).to.equal(false);

      await vault.initialize(owner);

      expect(await vault.getRoleMemberCount(adminRole)).to.equal(1);
      expect(await vault.hasRole(adminRole, owner)).to.equal(true);
      expect(await vault.hasRole(adminRole, stranger)).to.equal(false);
    });
  });

  context("finalizeUpgrade_v2()", () => {
    it("Should revert with UnexpectedContractVersion error when called on implementation", async () => {
      await expect(impl.finalizeUpgrade_v2(owner))
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(MAX_UINT256, 1);
    });

    it("Should revert with UnexpectedContractVersion error when called on deployed from scratch WithdrawalVaultV2", async () => {
      await vault.initialize(owner);

      await expect(vault.finalizeUpgrade_v2(owner))
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(2, 1);
    });

    context("Simulate upgrade from v1", () => {
      beforeEach(async () => {
        await vault.harness__initializeContractVersionTo(1);
      });

      it("Should revert if admin address is zero", async () => {
        await expect(vault.finalizeUpgrade_v2(ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      });

      it("Should set correct contract version", async () => {
        expect(await vault.getContractVersion()).to.equal(1);
        await vault.finalizeUpgrade_v2(owner);
        expect(await vault.getContractVersion()).to.be.equal(2);
      });

      it("Should set admin role during finalization", async () => {
        const adminRole = await vault.DEFAULT_ADMIN_ROLE();
        expect(await vault.getRoleMemberCount(adminRole)).to.equal(0);
        expect(await vault.hasRole(adminRole, owner)).to.equal(false);

        await vault.finalizeUpgrade_v2(owner);

        expect(await vault.getRoleMemberCount(adminRole)).to.equal(1);
        expect(await vault.hasRole(adminRole, owner)).to.equal(true);
        expect(await vault.hasRole(adminRole, stranger)).to.equal(false);
      });
    });
  });

  context("Access control", () => {
    it("Returns ACL roles", async () => {
      expect(await vault.ADD_FULL_WITHDRAWAL_REQUEST_ROLE()).to.equal(ADD_FULL_WITHDRAWAL_REQUEST_ROLE);
    });

    it("Sets up roles", async () => {
      await vault.initialize(owner);

      expect(await vault.getRoleMemberCount(ADD_FULL_WITHDRAWAL_REQUEST_ROLE)).to.equal(0);
      expect(await vault.hasRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus)).to.equal(false);

      await vault.connect(owner).grantRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus);

      expect(await vault.getRoleMemberCount(ADD_FULL_WITHDRAWAL_REQUEST_ROLE)).to.equal(1);
      expect(await vault.hasRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus)).to.equal(true);
    });
  });

  context("withdrawWithdrawals", () => {
    beforeEach(async () => await vault.initialize(owner));

    it("Reverts if the caller is not Lido", async () => {
      await expect(vault.connect(stranger).withdrawWithdrawals(0)).to.be.revertedWithCustomError(vault, "NotLido");
    });

    it("Reverts if amount is 0", async () => {
      await expect(lido.mock_withdrawFromVault(vaultAddress, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("Reverts if not enough funds are available", async () => {
      await expect(lido.mock_withdrawFromVault(vaultAddress, 1))
        .to.be.revertedWithCustomError(vault, "NotEnoughEther")
        .withArgs(1, 0);
    });

    it("Withdraws the requested amount", async () => {
      await setBalance(vaultAddress, 10);

      await expect(lido.mock_withdrawFromVault(vaultAddress, 1)).to.emit(lido, "WithdrawalsReceived").withArgs(1);
    });
  });

  context("recoverERC20", () => {
    let token: ERC20__Harness;
    let tokenAddress: string;

    before(async () => {
      token = await ethers.deployContract("ERC20__Harness", ["Test Token", "TT"]);

      tokenAddress = await token.getAddress();
    });

    it("Reverts if the token is not a contract", async () => {
      await expect(vault.recoverERC20(ZeroAddress, 1)).to.be.revertedWith("Address: call to non-contract");
    });

    it("Reverts if the recovered amount is 0", async () => {
      await expect(vault.recoverERC20(ZeroAddress, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("Transfers the requested amount", async () => {
      await token.mint(vaultAddress, 10);

      expect(await token.balanceOf(vaultAddress)).to.equal(10);
      expect(await token.balanceOf(treasury.address)).to.equal(0);

      await expect(vault.recoverERC20(tokenAddress, 1))
        .to.emit(vault, "ERC20Recovered")
        .withArgs(owner, tokenAddress, 1);

      expect(await token.balanceOf(vaultAddress)).to.equal(9);
      expect(await token.balanceOf(treasury.address)).to.equal(1);
    });
  });

  context("recoverERC721", () => {
    let token: ERC721__Harness;
    let tokenAddress: string;

    before(async () => {
      token = await ethers.deployContract("ERC721__Harness", ["Test NFT", "tNFT"]);

      tokenAddress = await token.getAddress();
    });

    it("Reverts if the token is not a contract", async () => {
      await expect(vault.recoverERC721(ZeroAddress, 0)).to.be.reverted;
    });

    it("Transfers the requested token id", async () => {
      await token.mint(vaultAddress, 1);

      expect(await token.ownerOf(1)).to.equal(vaultAddress);
      expect(await token.ownerOf(1)).to.not.equal(treasury.address);

      await expect(vault.recoverERC721(tokenAddress, 1))
        .to.emit(vault, "ERC721Recovered")
        .withArgs(owner, tokenAddress, 1);

      expect(await token.ownerOf(1)).to.equal(treasury.address);
    });
  });

  context("get triggerable withdrawal request fee", () => {
    it("Should get fee from the EIP 7002 contract", async function () {
      await withdrawalsPredeployed.mock__setFee(333n);
      expect(
        (await vault.getWithdrawalRequestFee()) == 333n,
        "withdrawal request should use fee from the EIP 7002 contract",
      );
    });

    it("Should revert if fee read fails", async function () {
      await withdrawalsPredeployed.mock__setFailOnGetFee(true);
      await expect(vault.getWithdrawalRequestFee()).to.be.revertedWithCustomError(vault, "WithdrawalFeeReadFailed");
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Shoud revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await withdrawalsPredeployed.mock__setFeeRaw(unexpectedFee);

        await expect(vault.getWithdrawalRequestFee()).to.be.revertedWithCustomError(vault, "WithdrawalFeeInvalidData");
      });
    });
  });

  async function getFee(): Promise<bigint> {
    const fee = await vault.getWithdrawalRequestFee();

    return ethers.parseUnits(fee.toString(), "wei");
  }

  async function getWithdrawalCredentialsContractBalance(): Promise<bigint> {
    const contractAddress = await vault.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  async function getWithdrawalsPredeployedContractBalance(): Promise<bigint> {
    const contractAddress = await withdrawalsPredeployed.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  context("add triggerable withdrawal requests", () => {
    beforeEach(async () => {
      await vault.initialize(owner);
      await vault.connect(owner).grantRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus);
      await vault.connect(owner).grantRole(ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus);
    });

    it("Should revert if the caller is not Validator Exit Bus", async () => {
      await expect(vault.connect(stranger).addFullWithdrawalRequests("0x1234")).to.be.revertedWithOZAccessControlError(
        stranger.address,
        ADD_FULL_WITHDRAWAL_REQUEST_ROLE,
      );

      await expect(
        vault.connect(stranger).addPartialWithdrawalRequests("0x1234", [1n]),
      ).to.be.revertedWithOZAccessControlError(stranger.address, ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE);
    });

    it("Should revert if empty arrays are provided", async function () {
      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests("0x", { value: 1n }),
      ).to.be.revertedWithCustomError(vault, "NoWithdrawalRequests");

      await expect(
        vault.connect(validatorsExitBus).addPartialWithdrawalRequests("0x", [], { value: 1n }),
      ).to.be.revertedWithCustomError(vault, "NoWithdrawalRequests");
    });

    it("Should revert if array lengths do not match", async function () {
      const requestCount = 2;
      const { pubkeysHexString } = generateWithdrawalRequestPayload(requestCount);
      const amounts = [1n];

      const totalWithdrawalFee = (await getFee()) * BigInt(requestCount);

      await expect(
        vault
          .connect(validatorsExitBus)
          .addPartialWithdrawalRequests(pubkeysHexString, amounts, { value: totalWithdrawalFee }),
      )
        .to.be.revertedWithCustomError(vault, "MismatchedArrayLengths")
        .withArgs(requestCount, amounts.length);

      await expect(
        vault
          .connect(validatorsExitBus)
          .addPartialWithdrawalRequests(pubkeysHexString, [], { value: totalWithdrawalFee }),
      )
        .to.be.revertedWithCustomError(vault, "MismatchedArrayLengths")
        .withArgs(requestCount, 0);
    });

    it("Should revert when a full withdrawal amount is included in 'addPartialWithdrawalRequests'", async function () {
      const { pubkeysHexString } = generateWithdrawalRequestPayload(2);
      const amounts = [1n, 0n]; // Partial and Full withdrawal
      const totalWithdrawalFee = (await getFee()) * BigInt(pubkeysHexString.length);

      await expect(
        vault
          .connect(validatorsExitBus)
          .addPartialWithdrawalRequests(pubkeysHexString, amounts, { value: totalWithdrawalFee }),
      ).to.be.revertedWithCustomError(vault, "PartialWithdrawalRequired");
    });

    it("Should revert if not enough fee is sent", async function () {
      const { pubkeysHexString, partialWithdrawalAmounts } = generateWithdrawalRequestPayload(1);

      await withdrawalsPredeployed.mock__setFee(3n); // Set fee to 3 gwei

      // 1. Should revert if no fee is sent
      await expect(vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeysHexString))
        .to.be.revertedWithCustomError(vault, "InsufficientFee")
        .withArgs(0, 3n);

      await expect(
        vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts),
      )
        .to.be.revertedWithCustomError(vault, "InsufficientFee")
        .withArgs(0, 3n);

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeysHexString, { value: insufficientFee }),
      )
        .to.be.revertedWithCustomError(vault, "InsufficientFee")
        .withArgs(2n, 3n);

      await expect(
        vault
          .connect(validatorsExitBus)
          .addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, { value: insufficientFee }),
      )
        .to.be.revertedWithCustomError(vault, "InsufficientFee")
        .withArgs(2n, 3n);
    });

    it("Should revert if pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const invalidPubkeyHexString = "0x1234";

      const fee = await getFee();

      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests(invalidPubkeyHexString, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "MalformedPubkeysArray");

      await expect(
        vault.connect(validatorsExitBus).addPartialWithdrawalRequests(invalidPubkeyHexString, [1n], { value: fee }),
      ).to.be.revertedWithCustomError(vault, "MalformedPubkeysArray");
    });

    it("Should revert if last pubkey not 48 bytes", async function () {
      const validPubey =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";
      const invalidPubkey = "1234";
      const pubkeysHexString = `0x${validPubey}${invalidPubkey}`;

      const fee = await getFee();

      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeysHexString, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "MalformedPubkeysArray");

      await expect(
        vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, [1n, 2n], { value: fee }),
      ).to.be.revertedWithCustomError(vault, "MalformedPubkeysArray");
    });

    it("Should revert if addition fails at the withdrawal request contract", async function () {
      const { pubkeysHexString, partialWithdrawalAmounts } = generateWithdrawalRequestPayload(1);
      const fee = await getFee();

      // Set mock to fail on add
      await withdrawalsPredeployed.mock__setFailOnAddRequest(true);

      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeysHexString, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "WithdrawalRequestAdditionFailed");

      await expect(
        vault
          .connect(validatorsExitBus)
          .addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "WithdrawalRequestAdditionFailed");
    });

    it("Should revert when fee read fails", async function () {
      await withdrawalsPredeployed.mock__setFailOnGetFee(true);

      const { pubkeysHexString, partialWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
      const fee = 10n;

      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeysHexString, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "WithdrawalFeeReadFailed");

      await expect(
        vault
          .connect(validatorsExitBus)
          .addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "WithdrawalFeeReadFailed");
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Should revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await withdrawalsPredeployed.mock__setFeeRaw(unexpectedFee);

        const { pubkeysHexString, partialWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
        const fee = 10n;

        await expect(
          vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeysHexString, { value: fee }),
        ).to.be.revertedWithCustomError(vault, "WithdrawalFeeInvalidData");

        await expect(
          vault
            .connect(validatorsExitBus)
            .addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, { value: fee }),
        ).to.be.revertedWithCustomError(vault, "WithdrawalFeeInvalidData");
      });
    });

    it("should revert if refund failed", async function () {
      const refundFailureTester: RefundFailureTester = await ethers.deployContract("RefundFailureTester", [
        vaultAddress,
      ]);
      const refundFailureTesterAddress = await refundFailureTester.getAddress();

      await vault.connect(owner).grantRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, refundFailureTesterAddress);
      await vault.connect(owner).grantRole(ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE, refundFailureTesterAddress);

      const requestCount = 3;
      const { pubkeysHexString, partialWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      await expect(
        refundFailureTester
          .connect(stranger)
          .addFullWithdrawalRequests(pubkeysHexString, { value: expectedTotalWithdrawalFee + 1n }),
      ).to.be.revertedWithCustomError(vault, "ExcessFeeRefundFailed");

      await expect(
        refundFailureTester.connect(stranger).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
          value: expectedTotalWithdrawalFee + 1n,
        }),
      ).to.be.revertedWithCustomError(vault, "ExcessFeeRefundFailed");

      await expect(
        refundFailureTester
          .connect(stranger)
          .addFullWithdrawalRequests(pubkeysHexString, { value: expectedTotalWithdrawalFee + ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(vault, "ExcessFeeRefundFailed");

      await expect(
        refundFailureTester.connect(stranger).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
          value: expectedTotalWithdrawalFee + ethers.parseEther("1"),
        }),
      ).to.be.revertedWithCustomError(vault, "ExcessFeeRefundFailed");
    });

    it("Should accept withdrawal requests when the provided fee matches the exact required amount", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(3n);
      const expectedTotalWithdrawalFee = 9n;

      await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addFullWithdrawalRequests(pubkeysHexString, { value: expectedTotalWithdrawalFee }),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
            value: expectedTotalWithdrawalFee,
          }),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );

      // Check extremely high fee
      const highFee = ethers.parseEther("10");
      await withdrawalsPredeployed.mock__setFee(highFee);
      const expectedLargeTotalWithdrawalFee = ethers.parseEther("30");

      await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addFullWithdrawalRequests(pubkeysHexString, { value: expectedLargeTotalWithdrawalFee }),
        pubkeys,
        fullWithdrawalAmounts,
        highFee,
      );

      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
            value: expectedLargeTotalWithdrawalFee,
          }),
        pubkeys,
        partialWithdrawalAmounts,
        highFee,
      );
    });

    it("Should accept withdrawal requests when the provided fee exceeds the required amount", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const withdrawalFee = 9n + 1n; // 3 request * 3 gwei (fee) + 1 gwei (extra fee)= 10 gwei

      await testEIP7002Mock(
        () => vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeysHexString, { value: withdrawalFee }),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, { value: withdrawalFee }),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );

      // Check when the provided fee extremely exceeds the required amount
      const largeWithdrawalFee = ethers.parseEther("10");

      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeysHexString, { value: largeWithdrawalFee }),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, { value: largeWithdrawalFee }),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );
    });

    it("Should not affect contract balance", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      const initialBalance = await getWithdrawalCredentialsContractBalance();

      await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addFullWithdrawalRequests(pubkeysHexString, { value: expectedTotalWithdrawalFee }),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );
      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);

      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
            value: expectedTotalWithdrawalFee,
          }),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );
      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);

      const excessTotalWithdrawalFee = 9n + 1n; // 3 requests * 3 gwei (fee) + 1 gwei (extra fee) = 10 gwei

      await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addFullWithdrawalRequests(pubkeysHexString, { value: excessTotalWithdrawalFee }),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);

      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
            value: excessTotalWithdrawalFee,
          }),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );

      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);
    });

    it("Should refund excess fee", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei
      const excessFee = 1n;

      let vebInitialBalance = await ethers.provider.getBalance(validatorsExitBus.address);

      const { receipt: fullWithdrawalReceipt } = await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addFullWithdrawalRequests(pubkeysHexString, { value: expectedTotalWithdrawalFee + excessFee }),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      expect(await ethers.provider.getBalance(validatorsExitBus.address)).to.equal(
        vebInitialBalance - expectedTotalWithdrawalFee - fullWithdrawalReceipt.gasUsed * fullWithdrawalReceipt.gasPrice,
      );

      vebInitialBalance = await ethers.provider.getBalance(validatorsExitBus.address);

      const { receipt: partialWithdrawalReceipt } = await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
            value: expectedTotalWithdrawalFee + excessFee,
          }),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );

      expect(await ethers.provider.getBalance(validatorsExitBus.address)).to.equal(
        vebInitialBalance -
          expectedTotalWithdrawalFee -
          partialWithdrawalReceipt.gasUsed * partialWithdrawalReceipt.gasPrice,
      );
    });

    it("Should transfer the total calculated fee to the EIP-7002 withdrawal contract", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(3n);
      const expectedTotalWithdrawalFee = 9n;
      const excessTotalWithdrawalFee = 9n + 1n;

      let initialBalance = await getWithdrawalsPredeployedContractBalance();

      await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addFullWithdrawalRequests(pubkeysHexString, { value: expectedTotalWithdrawalFee }),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);

      initialBalance = await getWithdrawalsPredeployedContractBalance();

      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
            value: expectedTotalWithdrawalFee,
          }),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );

      expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);

      initialBalance = await getWithdrawalsPredeployedContractBalance();
      await testEIP7002Mock(
        () =>
          vault
            .connect(validatorsExitBus)
            .addFullWithdrawalRequests(pubkeysHexString, { value: excessTotalWithdrawalFee }),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);

      initialBalance = await getWithdrawalsPredeployedContractBalance();
      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
            value: excessTotalWithdrawalFee,
          }),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );

      expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);
    });

    it("Should ensure withdrawal requests are encoded as expected with a 48-byte pubkey and 8-byte amount", async function () {
      const requestCount = 16;
      const { pubkeysHexString, pubkeys, partialWithdrawalAmounts, fullWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);
      const totalWithdrawalFee = 333n;

      const testEncoding = async (
        tx: ContractTransactionResponse,
        expectedPubkeys: string[],
        expectedAmounts: bigint[],
      ) => {
        const receipt = await tx.wait();

        const events = findEIP7002MockEvents(receipt!);
        expect(events.length).to.equal(requestCount);

        for (let i = 0; i < requestCount; i++) {
          const encodedRequest = events[i].args[0];
          // 0x (2 characters) + 48-byte pubkey (96 characters) + 8-byte amount (16 characters) = 114 characters
          expect(encodedRequest.length).to.equal(114);

          expect(encodedRequest.slice(0, 2)).to.equal("0x");
          expect(encodedRequest.slice(2, 98)).to.equal(expectedPubkeys[i]);
          expect(encodedRequest.slice(98, 114)).to.equal(expectedAmounts[i].toString(16).padStart(16, "0"));
        }
      };

      const txFullWithdrawal = await vault
        .connect(validatorsExitBus)
        .addFullWithdrawalRequests(pubkeysHexString, { value: totalWithdrawalFee });

      await testEncoding(txFullWithdrawal, pubkeys, fullWithdrawalAmounts);

      const txPartialWithdrawal = await vault
        .connect(validatorsExitBus)
        .addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, { value: totalWithdrawalFee });

      await testEncoding(txPartialWithdrawal, pubkeys, partialWithdrawalAmounts);
    });

    const testCasesForWithdrawalRequests = [
      { requestCount: 1, extraFee: 0n },
      { requestCount: 1, extraFee: 100n },
      { requestCount: 1, extraFee: 100_000_000_000n },
      { requestCount: 3, extraFee: 0n },
      { requestCount: 3, extraFee: 1n },
      { requestCount: 7, extraFee: 3n },
      { requestCount: 10, extraFee: 0n },
      { requestCount: 10, extraFee: 100_000_000_000n },
      { requestCount: 100, extraFee: 0n },
    ];

    testCasesForWithdrawalRequests.forEach(({ requestCount, extraFee }) => {
      it(`Should successfully add ${requestCount} requests with extra fee ${extraFee}`, async () => {
        const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts } =
          generateWithdrawalRequestPayload(requestCount);
        const expectedFee = await getFee();
        const expectedTotalWithdrawalFee = expectedFee * BigInt(requestCount);

        const initialBalance = await getWithdrawalCredentialsContractBalance();
        let vebInitialBalance = await ethers.provider.getBalance(validatorsExitBus.address);

        const { receipt: receiptFullWithdrawal } = await testEIP7002Mock(
          () =>
            vault
              .connect(validatorsExitBus)
              .addFullWithdrawalRequests(pubkeysHexString, { value: expectedTotalWithdrawalFee + extraFee }),
          pubkeys,
          fullWithdrawalAmounts,
          expectedFee,
        );

        expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);
        expect(await ethers.provider.getBalance(validatorsExitBus.address)).to.equal(
          vebInitialBalance -
            expectedTotalWithdrawalFee -
            receiptFullWithdrawal.gasUsed * receiptFullWithdrawal.gasPrice,
        );

        vebInitialBalance = await ethers.provider.getBalance(validatorsExitBus.address);
        const { receipt: receiptPartialWithdrawal } = await testEIP7002Mock(
          () =>
            vault.connect(validatorsExitBus).addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, {
              value: expectedTotalWithdrawalFee + extraFee,
            }),
          pubkeys,
          partialWithdrawalAmounts,
          expectedFee,
        );

        expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);
        expect(await ethers.provider.getBalance(validatorsExitBus.address)).to.equal(
          vebInitialBalance -
            expectedTotalWithdrawalFee -
            receiptPartialWithdrawal.gasUsed * receiptPartialWithdrawal.gasPrice,
        );
      });
    });
  });
});
