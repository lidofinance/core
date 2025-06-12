import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  EIP7002WithdrawalRequest__Mock,
  ERC20__Harness,
  ERC721__Harness,
  Lido__MockForWithdrawalVault,
  WithdrawalVault__Harness,
} from "typechain-types";

import { EIP7002_ADDRESS, EIP7002_MIN_WITHDRAWAL_REQUEST_FEE, MAX_UINT256, proxify } from "lib";

import { Snapshot } from "test/suite";

import {
  deployEIP7002WithdrawalRequestContractMock,
  encodeEIP7002Payload,
  findEIP7002MockEvents,
  testEIP7002Mock,
} from "./eip7002Mock";
import { generateWithdrawalRequestPayload } from "./utils";

const PETRIFIED_VERSION = MAX_UINT256;

describe("WithdrawalVault.sol", () => {
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let triggerableWithdrawalsGateway: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  let withdrawalsPredeployed: EIP7002WithdrawalRequest__Mock;
  let lido: Lido__MockForWithdrawalVault;
  let lidoAddress: string;

  let impl: WithdrawalVault__Harness;
  let vault: WithdrawalVault__Harness;
  let vaultAddress: string;

  before(async () => {
    [owner, user, treasury] = await ethers.getSigners();
    // TODO
    [owner, treasury, triggerableWithdrawalsGateway, stranger] = await ethers.getSigners();

    withdrawalsPredeployed = await deployEIP7002WithdrawalRequestContractMock(EIP7002_MIN_WITHDRAWAL_REQUEST_FEE);

    expect(await withdrawalsPredeployed.getAddress()).to.equal(EIP7002_ADDRESS);

    lido = await ethers.deployContract("Lido__MockForWithdrawalVault");
    lidoAddress = await lido.getAddress();

    impl = await ethers.deployContract(
      "WithdrawalVault__Harness",
      [lidoAddress, treasury.address, triggerableWithdrawalsGateway.address],
      owner,
    );

    [vault] = await proxify({ impl, admin: owner });

    vaultAddress = await vault.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constructor", () => {
    it("Reverts if the Lido address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [
          ZeroAddress,
          treasury.address,
          triggerableWithdrawalsGateway.address,
        ]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the treasury address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [lidoAddress, ZeroAddress, triggerableWithdrawalsGateway.address]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the triggerable withdrawal gateway address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [lidoAddress, treasury.address, ZeroAddress]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
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
      await vault.initialize();

      await expect(vault.initialize()).to.be.revertedWithCustomError(vault, "UnexpectedContractVersion").withArgs(2, 0);
    });

    it("Initializes the contract", async () => {
      await expect(vault.initialize()).to.emit(vault, "ContractVersionSet").withArgs(2);
    });
  });

  context("finalizeUpgrade_v2()", () => {
    it("Should revert with UnexpectedContractVersion error when called on implementation", async () => {
      await expect(impl.finalizeUpgrade_v2())
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(MAX_UINT256, 1);
    });

    it("Should revert with UnexpectedContractVersion error when called on deployed from scratch WithdrawalVaultV2", async () => {
      await vault.initialize();

      await expect(vault.finalizeUpgrade_v2())
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(2, 1);
    });

    context("Simulate upgrade from v1", () => {
      beforeEach(async () => {
        await vault.harness__initializeContractVersionTo(1);
      });

      it("Should set correct contract version", async () => {
        expect(await vault.getContractVersion()).to.equal(1);
        await vault.finalizeUpgrade_v2();
        expect(await vault.getContractVersion()).to.be.equal(2);
      });
    });
  });

  context("withdrawWithdrawals", () => {
    beforeEach(async () => await vault.initialize());

    it("Reverts if the caller is not Lido", async () => {
      await expect(vault.connect(user).withdrawWithdrawals(0)).to.be.revertedWithCustomError(vault, "NotLido");
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
      await expect(vault.getWithdrawalRequestFee()).to.be.revertedWithCustomError(vault, "FeeReadFailed");
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Should revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await withdrawalsPredeployed.mock__setFeeRaw(unexpectedFee);

        await expect(vault.getWithdrawalRequestFee()).to.be.revertedWithCustomError(vault, "FeeInvalidData");
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
      await vault.initialize();
    });

    it("Should revert if the caller is not Triggerable Withdrawal Gateway", async () => {
      await expect(vault.connect(stranger).addWithdrawalRequests(["0x1234"], [1n])).to.be.revertedWithCustomError(
        vault,
        "NotTriggerableWithdrawalsGateway",
      );
    });

    it("Should revert if empty arrays are provided", async function () {
      await expect(vault.connect(triggerableWithdrawalsGateway).addWithdrawalRequests([], [], { value: 1n }))
        .to.be.revertedWithCustomError(vault, "ZeroArgument")
        .withArgs("pubkeys");
    });

    it("Should revert if array lengths do not match", async function () {
      const requestCount = 2;
      const { pubkeysHexArray } = generateWithdrawalRequestPayload(requestCount);
      const amounts = [1n];

      const totalWithdrawalFee = (await getFee()) * BigInt(requestCount);

      await expect(
        vault
          .connect(triggerableWithdrawalsGateway)
          .addWithdrawalRequests(pubkeysHexArray, amounts, { value: totalWithdrawalFee }),
      )
        .to.be.revertedWithCustomError(vault, "ArraysLengthMismatch")
        .withArgs(requestCount, amounts.length);

      await expect(
        vault
          .connect(triggerableWithdrawalsGateway)
          .addWithdrawalRequests(pubkeysHexArray, [], { value: totalWithdrawalFee }),
      )
        .to.be.revertedWithCustomError(vault, "ArraysLengthMismatch")
        .withArgs(requestCount, 0);
    });

    it("Should revert if not enough fee is sent", async function () {
      const { pubkeysHexArray, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(1);

      await withdrawalsPredeployed.mock__setFee(3n); // Set fee to 3 gwei

      // 1. Should revert if no fee is sent
      await expect(
        vault.connect(triggerableWithdrawalsGateway).addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts),
      )
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(3n, 0);

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(
        vault
          .connect(triggerableWithdrawalsGateway)
          .addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, { value: insufficientFee }),
      )
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(3n, 2n);
    });

    it("Should revert if pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const invalidPubkeyHexString = ["0x1234"];

      const fee = await getFee();
      await expect(
        vault
          .connect(triggerableWithdrawalsGateway)
          .addWithdrawalRequests(invalidPubkeyHexString, [1n], { value: fee }),
      ).to.be.revertedWithPanic(1); // assertion
    });

    it("Should revert if last pubkey not 48 bytes", async function () {
      const validPubkey =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";
      const invalidPubkey = "1234";
      const pubkeysHexArray = [`0x${validPubkey}`, `0x${invalidPubkey}`];

      const fee = (await getFee()) * 2n; // 2 requests

      await expect(
        vault.connect(triggerableWithdrawalsGateway).addWithdrawalRequests(pubkeysHexArray, [1n, 2n], { value: fee }),
      ).to.be.revertedWithPanic(1); // assertion
    });

    it("Should revert if addition fails at the withdrawal request contract", async function () {
      const { pubkeysHexArray, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(1);
      const fee = await getFee();

      // Set mock to fail on add
      await withdrawalsPredeployed.mock__setFailOnAddRequest(true);

      await expect(
        vault
          .connect(triggerableWithdrawalsGateway)
          .addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "RequestAdditionFailed");
    });

    it("Should revert when fee read fails", async function () {
      await withdrawalsPredeployed.mock__setFailOnGetFee(true);

      const { pubkeysHexArray, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
      const fee = 10n;

      await expect(
        vault
          .connect(triggerableWithdrawalsGateway)
          .addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "FeeReadFailed");
    });

    it("Should revert when the provided fee exceeds the required amount", async function () {
      const requestCount = 3;
      const { pubkeysHexArray, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const withdrawalFee = 9n + 1n; // 3 request * 3 gwei (fee) + 1 gwei (extra fee)= 10 gwei

      await expect(
        vault
          .connect(triggerableWithdrawalsGateway)
          .addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, { value: withdrawalFee }),
      )
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(9n, 10n);
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Should revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await withdrawalsPredeployed.mock__setFeeRaw(unexpectedFee);

        const { pubkeysHexArray, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
        const fee = 10n;

        await expect(
          vault
            .connect(triggerableWithdrawalsGateway)
            .addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, { value: fee }),
        ).to.be.revertedWithCustomError(vault, "FeeInvalidData");
      });
    });

    it("Should accept withdrawal requests when the provided fee matches the exact required amount", async function () {
      const requestCount = 3;
      const { pubkeysHexArray, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(3n);
      const expectedTotalWithdrawalFee = 9n;

      await testEIP7002Mock(
        () =>
          vault.connect(triggerableWithdrawalsGateway).addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, {
            value: expectedTotalWithdrawalFee,
          }),
        pubkeys,
        mixedWithdrawalAmounts,
        fee,
      );

      // Check extremely high fee
      const highFee = ethers.parseEther("10");
      await withdrawalsPredeployed.mock__setFee(highFee);
      const expectedLargeTotalWithdrawalFee = ethers.parseEther("30");

      await testEIP7002Mock(
        () =>
          vault.connect(triggerableWithdrawalsGateway).addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, {
            value: expectedLargeTotalWithdrawalFee,
          }),
        pubkeys,
        mixedWithdrawalAmounts,
        highFee,
      );
    });

    it("Should emit withdrawal event", async function () {
      const requestCount = 3;
      const { pubkeysHexArray, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      await expect(
        vault.connect(triggerableWithdrawalsGateway).addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, {
          value: expectedTotalWithdrawalFee,
        }),
      )
        .to.emit(vault, "WithdrawalRequestAdded")
        .withArgs(encodeEIP7002Payload(pubkeys[0], mixedWithdrawalAmounts[0]))
        .and.to.emit(vault, "WithdrawalRequestAdded")
        .withArgs(encodeEIP7002Payload(pubkeys[1], mixedWithdrawalAmounts[1]))
        .and.to.emit(vault, "WithdrawalRequestAdded")
        .withArgs(encodeEIP7002Payload(pubkeys[2], mixedWithdrawalAmounts[2]));
    });

    it("Should not affect contract balance", async function () {
      const requestCount = 3;
      const { pubkeysHexArray, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      const initialBalance = await getWithdrawalCredentialsContractBalance();

      await testEIP7002Mock(
        () =>
          vault.connect(triggerableWithdrawalsGateway).addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, {
            value: expectedTotalWithdrawalFee,
          }),
        pubkeys,
        mixedWithdrawalAmounts,
        fee,
      );
      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);
    });

    it("Should transfer the total calculated fee to the EIP-7002 withdrawal contract", async function () {
      const requestCount = 3;
      const { pubkeysHexArray, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(3n);
      const expectedTotalWithdrawalFee = 9n;

      const initialBalance = await getWithdrawalsPredeployedContractBalance();
      await testEIP7002Mock(
        () =>
          vault.connect(triggerableWithdrawalsGateway).addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, {
            value: expectedTotalWithdrawalFee,
          }),
        pubkeys,
        mixedWithdrawalAmounts,
        fee,
      );

      expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);
    });

    it("Should ensure withdrawal requests are encoded as expected with a 48-byte pubkey and 8-byte amount", async function () {
      const requestCount = 16;
      const { pubkeysHexArray, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const tx = await vault
        .connect(triggerableWithdrawalsGateway)
        .addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, { value: 16n });

      const receipt = await tx.wait();

      const events = findEIP7002MockEvents(receipt!);
      expect(events.length).to.equal(requestCount);

      for (let i = 0; i < requestCount; i++) {
        const encodedRequest = events[i].args[0];
        // 0x (2 characters) + 48-byte pubkey (96 characters) + 8-byte amount (16 characters) = 114 characters
        expect(encodedRequest.length).to.equal(114);

        expect(encodedRequest.slice(0, 2)).to.equal("0x");
        expect(encodedRequest.slice(2, 98)).to.equal(pubkeys[i]);
        expect(encodedRequest.slice(98, 114)).to.equal(mixedWithdrawalAmounts[i].toString(16).padStart(16, "0"));
      }
    });

    const testCasesForWithdrawalRequests = [
      { requestCount: 1 },
      { requestCount: 3 },
      { requestCount: 7 },
      { requestCount: 10 },
      { requestCount: 100 },
    ];

    testCasesForWithdrawalRequests.forEach(({ requestCount }) => {
      it(`Should successfully add ${requestCount} requests`, async () => {
        const { pubkeysHexArray, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);
        const expectedFee = await getFee();
        const expectedTotalWithdrawalFee = expectedFee * BigInt(requestCount);

        const initialBalance = await getWithdrawalCredentialsContractBalance();
        const vebInitialBalance = await ethers.provider.getBalance(triggerableWithdrawalsGateway.address);

        const { receipt: receiptPartialWithdrawal } = await testEIP7002Mock(
          () =>
            vault
              .connect(triggerableWithdrawalsGateway)
              .addWithdrawalRequests(pubkeysHexArray, mixedWithdrawalAmounts, {
                value: expectedTotalWithdrawalFee,
              }),
          pubkeys,
          mixedWithdrawalAmounts,
          expectedFee,
        );

        expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);
        expect(await ethers.provider.getBalance(triggerableWithdrawalsGateway.address)).to.equal(
          vebInitialBalance -
            expectedTotalWithdrawalFee -
            receiptPartialWithdrawal.gasUsed * receiptPartialWithdrawal.gasPrice,
        );
      });
    });
  });
});
