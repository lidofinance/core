import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  EIP7002WithdrawalRequest__Mock,
  Lido__MockForWithdrawalVault,
  WithdrawalVault__Harness,
} from "typechain-types";

import { deployEIP7002WithdrawalRequestContract, EIP7002_ADDRESS, proxify, streccak } from "lib";

import { Snapshot } from "test/suite";

import { encodeEIP7002Payload, findEIP7002MockEvents, testEIP7002Mock } from "./eip7002Mock";
import { generateWithdrawalRequestPayload } from "./utils";

const ADD_WITHDRAWAL_REQUEST_ROLE = streccak("ADD_WITHDRAWAL_REQUEST_ROLE");

describe("WithdrawalVault.sol:eip7002 Triggerable Withdrawals", () => {
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

  before(async () => {
    [owner, treasury, validatorsExitBus, stranger] = await ethers.getSigners();

    withdrawalsPredeployed = await deployEIP7002WithdrawalRequestContract(1n);

    expect(await withdrawalsPredeployed.getAddress()).to.equal(EIP7002_ADDRESS);

    lido = await ethers.deployContract("Lido__MockForWithdrawalVault");
    lidoAddress = await lido.getAddress();

    impl = await ethers.deployContract("WithdrawalVault__Harness", [lidoAddress, treasury.address], owner);

    [vault] = await proxify({ impl, admin: owner });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

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
      it(`Shoud revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await withdrawalsPredeployed.mock__setFeeRaw(unexpectedFee);

        await expect(vault.getWithdrawalRequestFee()).to.be.revertedWithCustomError(vault, "FeeInvalidData");
      });
    });
  });

  context("add triggerable withdrawal requests", () => {
    beforeEach(async () => {
      await vault.initialize(owner);
      await vault.connect(owner).grantRole(ADD_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus);
    });

    it("Should revert if the caller is not Validator Exit Bus", async () => {
      await expect(
        vault.connect(stranger).addWithdrawalRequests("0x1234", [1n]),
      ).to.be.revertedWithOZAccessControlError(stranger.address, ADD_WITHDRAWAL_REQUEST_ROLE);
    });

    it("Should revert if empty arrays are provided", async function () {
      await expect(vault.connect(validatorsExitBus).addWithdrawalRequests("0x", [], { value: 1n }))
        .to.be.revertedWithCustomError(vault, "ZeroArgument")
        .withArgs("pubkeys");
    });

    it("Should revert if array lengths do not match", async function () {
      const requestCount = 2;
      const { pubkeysHexString } = generateWithdrawalRequestPayload(requestCount);
      const amounts = [1n];

      const totalWithdrawalFee = (await getFee()) * BigInt(requestCount);

      await expect(
        vault
          .connect(validatorsExitBus)
          .addWithdrawalRequests(pubkeysHexString, amounts, { value: totalWithdrawalFee }),
      )
        .to.be.revertedWithCustomError(vault, "ArraysLengthMismatch")
        .withArgs(requestCount, amounts.length);

      await expect(
        vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, [], { value: totalWithdrawalFee }),
      )
        .to.be.revertedWithCustomError(vault, "ArraysLengthMismatch")
        .withArgs(requestCount, 0);
    });

    it("Should revert if not enough fee is sent", async function () {
      const { pubkeysHexString, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(1);

      await withdrawalsPredeployed.mock__setFee(3n); // Set fee to 3 gwei

      // 1. Should revert if no fee is sent
      await expect(vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts))
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(0, 3n);

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(
        vault
          .connect(validatorsExitBus)
          .addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, { value: insufficientFee }),
      )
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(2n, 3n);
    });

    it("Should revert if pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const invalidPubkeyHexString = "0x1234";

      const fee = await getFee();
      await expect(
        vault.connect(validatorsExitBus).addWithdrawalRequests(invalidPubkeyHexString, [1n], { value: fee }),
      ).to.be.revertedWithCustomError(vault, "MalformedPubkeysArray");
    });

    it("Should revert if last pubkey not 48 bytes", async function () {
      const validPubey =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";
      const invalidPubkey = "1234";
      const pubkeysHexString = `0x${validPubey}${invalidPubkey}`;

      const fee = await getFee();

      await expect(
        vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, [1n, 2n], { value: fee }),
      ).to.be.revertedWithCustomError(vault, "MalformedPubkeysArray");
    });

    it("Should revert if addition fails at the withdrawal request contract", async function () {
      const { pubkeysHexString, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(1);
      const fee = await getFee();

      // Set mock to fail on add
      await withdrawalsPredeployed.mock__setFailOnAddRequest(true);

      await expect(
        vault
          .connect(validatorsExitBus)
          .addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "RequestAdditionFailed");
    });

    it("Should revert when fee read fails", async function () {
      await withdrawalsPredeployed.mock__setFailOnGetFee(true);

      const { pubkeysHexString, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
      const fee = 10n;

      await expect(
        vault
          .connect(validatorsExitBus)
          .addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "FeeReadFailed");
    });

    it("Should revert when the provided fee exceeds the required amount", async function () {
      const requestCount = 3;
      const { pubkeysHexString, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const withdrawalFee = 9n + 1n; // 3 request * 3 gwei (fee) + 1 gwei (extra fee)= 10 gwei

      await expect(
        vault
          .connect(validatorsExitBus)
          .addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, { value: withdrawalFee }),
      )
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(10n, 9n);
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Should revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await withdrawalsPredeployed.mock__setFeeRaw(unexpectedFee);

        const { pubkeysHexString, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
        const fee = 10n;

        await expect(
          vault
            .connect(validatorsExitBus)
            .addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, { value: fee }),
        ).to.be.revertedWithCustomError(vault, "FeeInvalidData");
      });
    });

    it("Should accept withdrawal requests when the provided fee matches the exact required amount", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(3n);
      const expectedTotalWithdrawalFee = 9n;

      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, {
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
          vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, {
            value: expectedLargeTotalWithdrawalFee,
          }),
        pubkeys,
        mixedWithdrawalAmounts,
        highFee,
      );
    });

    it("Should emit withdrawal event", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      await expect(
        vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, {
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
      const { pubkeysHexString, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(fee);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      const initialBalance = await getWithdrawalCredentialsContractBalance();

      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, {
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
      const { pubkeysHexString, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.mock__setFee(3n);
      const expectedTotalWithdrawalFee = 9n;

      const initialBalance = await getWithdrawalsPredeployedContractBalance();
      await testEIP7002Mock(
        () =>
          vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, {
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
      const { pubkeysHexString, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);

      const tx = await vault
        .connect(validatorsExitBus)
        .addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, { value: 16n });

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
        const { pubkeysHexString, pubkeys, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);
        const expectedFee = await getFee();
        const expectedTotalWithdrawalFee = expectedFee * BigInt(requestCount);

        const initialBalance = await getWithdrawalCredentialsContractBalance();
        const vebInitialBalance = await ethers.provider.getBalance(validatorsExitBus.address);

        const { receipt: receiptPartialWithdrawal } = await testEIP7002Mock(
          () =>
            vault.connect(validatorsExitBus).addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, {
              value: expectedTotalWithdrawalFee,
            }),
          pubkeys,
          mixedWithdrawalAmounts,
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
