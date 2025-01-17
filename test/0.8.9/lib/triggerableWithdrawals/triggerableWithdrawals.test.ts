import { expect } from "chai";
import { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { TriggerableWithdrawals_Harness, WithdrawalsPredeployed_Mock } from "typechain-types";

import { Snapshot } from "test/suite";

import { findEip7002TriggerableWithdrawalMockEvents, findEvents } from "./findEvents";
import {
  deployWithdrawalsPredeployedMock,
  generateWithdrawalRequestPayload,
  withdrawalsPredeployedHardcodedAddress,
} from "./utils";

describe("TriggerableWithdrawals.sol", () => {
  let actor: HardhatEthersSigner;

  let withdrawalsPredeployed: WithdrawalsPredeployed_Mock;
  let triggerableWithdrawals: TriggerableWithdrawals_Harness;

  let originalState: string;

  async function getWithdrawalCredentialsContractBalance(): Promise<bigint> {
    const contractAddress = await triggerableWithdrawals.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  async function getWithdrawalsPredeployedContractBalance(): Promise<bigint> {
    const contractAddress = await withdrawalsPredeployed.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  const MAX_UINT64 = (1n << 64n) - 1n;

  before(async () => {
    [actor] = await ethers.getSigners();

    withdrawalsPredeployed = await deployWithdrawalsPredeployedMock(1n);
    triggerableWithdrawals = await ethers.deployContract("TriggerableWithdrawals_Harness");

    expect(await withdrawalsPredeployed.getAddress()).to.equal(withdrawalsPredeployedHardcodedAddress);

    await triggerableWithdrawals.connect(actor).deposit({ value: ethers.parseEther("1") });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  async function getFee(): Promise<bigint> {
    return await triggerableWithdrawals.getWithdrawalRequestFee();
  }

  context("eip 7002 contract", () => {
    it("Should return the address of the EIP 7002 contract", async function () {
      expect(await triggerableWithdrawals.getWithdrawalsContractAddress()).to.equal(
        withdrawalsPredeployedHardcodedAddress,
      );
    });
  });

  context("get triggerable withdrawal request fee", () => {
    it("Should get fee from the EIP 7002 contract", async function () {
      await withdrawalsPredeployed.setFee(333n);
      expect(
        (await triggerableWithdrawals.getWithdrawalRequestFee()) == 333n,
        "withdrawal request should use fee from the EIP 7002 contract",
      );
    });

    it("Should revert if fee read fails", async function () {
      await withdrawalsPredeployed.setFailOnGetFee(true);
      await expect(triggerableWithdrawals.getWithdrawalRequestFee()).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "WithdrawalRequestFeeReadFailed",
      );
    });
  });

  context("add triggerable withdrawal requests", () => {
    it("Should revert if empty arrays are provided", async function () {
      await expect(triggerableWithdrawals.addFullWithdrawalRequests([], 1n)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "NoWithdrawalRequests",
      );

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests([], [], 1n)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "NoWithdrawalRequests",
      );

      await expect(triggerableWithdrawals.addWithdrawalRequests([], [], 1n)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "NoWithdrawalRequests",
      );
    });

    it("Should revert if array lengths do not match", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(2);
      const amounts = [1n];

      const fee = await getFee();

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(pubkeys.length, amounts.length);

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, [], fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(pubkeys.length, 0);

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests([], amounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(0, amounts.length);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(pubkeys.length, amounts.length);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeys, [], fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(pubkeys.length, 0);

      await expect(triggerableWithdrawals.addWithdrawalRequests([], amounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(0, amounts.length);
    });

    it("Should revert if not enough fee is sent", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(1);
      const amounts = [10n];

      await withdrawalsPredeployed.setFee(3n); // Set fee to 3 gwei

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, insufficientFee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientRequestFee")
        .withArgs(2n, 3n);

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, insufficientFee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientRequestFee")
        .withArgs(2n, 3n);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, insufficientFee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientRequestFee")
        .withArgs(2n, 3n);
    });

    it("Should revert if any pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const pubkeys = ["0x1234"];
      const amounts = [10n];

      const fee = await getFee();

      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPubkeyLength")
        .withArgs(pubkeys[0]);

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPubkeyLength")
        .withArgs(pubkeys[0]);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPubkeyLength")
        .withArgs(pubkeys[0]);
    });

    it("Should revert if addition fails at the withdrawal request contract", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(1);
      const amounts = [10n];

      const fee = await getFee();

      // Set mock to fail on add
      await withdrawalsPredeployed.setFailOnAddRequest(true);

      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "WithdrawalRequestAdditionFailed",
      );

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestAdditionFailed");

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, fee)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "WithdrawalRequestAdditionFailed",
      );
    });

    it("Should revert when a full withdrawal amount is included in 'addPartialWithdrawalRequests'", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(2);
      const amounts = [1n, 0n]; // Partial and Full withdrawal
      const fee = await getFee();

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "PartialWithdrawalRequired");
    });

    it("Should revert when balance is less than total withdrawal fee", async function () {
      const keysCount = 2;
      const fee = 10n;
      const balance = 19n;
      const expectedMinimalBalance = 20n;

      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(keysCount);

      await withdrawalsPredeployed.setFee(fee);
      await setBalance(await triggerableWithdrawals.getAddress(), balance);

      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, expectedMinimalBalance);

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, expectedMinimalBalance);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, expectedMinimalBalance);
    });

    it("Should revert when fee read fails", async function () {
      await withdrawalsPredeployed.setFailOnGetFee(true);

      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
      const fee = 10n;

      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "WithdrawalRequestFeeReadFailed",
      );

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestFeeReadFailed");

      await expect(
        triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestFeeReadFailed");
    });

    // ToDo: should accept when fee not defined

    it("Should accept withdrawal requests when the provided fee matches the exact required amount", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.setFee(3n);

      await triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee);
      await triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee);

      // Check extremely high fee
      const highFee = ethers.parseEther("10");
      await withdrawalsPredeployed.setFee(highFee);

      await triggerableWithdrawals.connect(actor).deposit({ value: highFee * BigInt(requestCount) * 3n });

      await triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, highFee);
      await triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, highFee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, highFee);
    });

    it("Should accept withdrawal requests when the provided fee exceeds the required amount", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const fee = 4n;

      await triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee);
      await triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee);

      // Check when the provided fee extremely exceeds the required amount
      const largeFee = ethers.parseEther("10");
      await triggerableWithdrawals.connect(actor).deposit({ value: largeFee * BigInt(requestCount) * 3n });

      await triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, largeFee);
      await triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, largeFee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, largeFee);
    });

    it("Should correctly deduct the exact fee amount from the contract balance", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 4n;
      const expectedTotalWithdrawalFee = 12n; // fee * requestCount;

      const testFeeDeduction = async (addRequests: () => Promise<ContractTransactionResponse>) => {
        const initialBalance = await getWithdrawalCredentialsContractBalance();
        await addRequests();
        expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance - expectedTotalWithdrawalFee);
      };

      await testFeeDeduction(() => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee));
      await testFeeDeduction(() =>
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
      );
      await testFeeDeduction(() => triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee));
    });

    it("Should transfer the total calculated fee to the EIP-7002 withdrawal contract", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      const expectedTotalWithdrawalFee = 9n; // fee * requestCount;

      const testFeeTransfer = async (addRequests: () => Promise<ContractTransactionResponse>) => {
        const initialBalance = await getWithdrawalsPredeployedContractBalance();
        await addRequests();
        expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);
      };

      await testFeeTransfer(() => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee));
      await testFeeTransfer(() =>
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
      );
      await testFeeTransfer(() => triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee));
    });

    it("Should accept full, partial, and mixed withdrawal requests via 'addWithdrawalRequests' function", async function () {
      const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(3);
      const fee = await getFee();

      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, fullWithdrawalAmounts, fee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee);
    });

    it("Should handle maximum uint64 withdrawal amount in partial withdrawal requests", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(1);
      const amounts = [MAX_UINT64];

      await triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, 10n);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, 10n);
    });

    it("Should emit a 'WithdrawalRequestAdded' event when a new withdrawal request is added", async function () {
      const requestCount = 3;
      const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);
      const fee = 10n;

      const testEventsEmit = async (
        addRequests: () => Promise<ContractTransactionResponse>,
        expectedPubKeys: string[],
        expectedAmounts: bigint[],
      ) => {
        const tx = await addRequests();

        const receipt = await tx.wait();
        const events = findEvents(receipt!, "WithdrawalRequestAdded");
        expect(events.length).to.equal(requestCount);

        for (let i = 0; i < requestCount; i++) {
          expect(events[i].args[0]).to.equal(expectedPubKeys[i]);
          expect(events[i].args[1]).to.equal(expectedAmounts[i]);
        }
      };

      await testEventsEmit(
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee),
        pubkeys,
        fullWithdrawalAmounts,
      );
      await testEventsEmit(
        () => triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
        pubkeys,
        partialWithdrawalAmounts,
      );
      await testEventsEmit(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee),
        pubkeys,
        mixedWithdrawalAmounts,
      );
    });

    it("Should verify correct fee distribution among requests", async function () {
      const requestCount = 5;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const testFeeDistribution = async (fee: bigint) => {
        const checkEip7002MockEvents = async (addRequests: () => Promise<ContractTransactionResponse>) => {
          const tx = await addRequests();

          const receipt = await tx.wait();
          const events = findEip7002TriggerableWithdrawalMockEvents(receipt!, "eip7002WithdrawalRequestAdded");
          expect(events.length).to.equal(requestCount);

          for (let i = 0; i < requestCount; i++) {
            expect(events[i].args[1]).to.equal(fee);
          }
        };

        await checkEip7002MockEvents(() => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee));

        await checkEip7002MockEvents(() =>
          triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
        );

        await checkEip7002MockEvents(() =>
          triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee),
        );
      };

      await testFeeDistribution(1n);
      await testFeeDistribution(2n);
      await testFeeDistribution(3n);
    });

    it("Should ensure withdrawal requests are encoded as expected with a 48-byte pubkey and 8-byte amount", async function () {
      const requestCount = 16;
      const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);
      const fee = 333n;

      const normalize = (hex: string) => (hex.startsWith("0x") ? hex.slice(2).toLowerCase() : hex.toLowerCase());

      const testEncoding = async (
        addRequests: () => Promise<ContractTransactionResponse>,
        expectedPubKeys: string[],
        expectedAmounts: bigint[],
      ) => {
        const tx = await addRequests();

        const receipt = await tx.wait();

        const events = findEip7002TriggerableWithdrawalMockEvents(receipt!, "eip7002WithdrawalRequestAdded");
        expect(events.length).to.equal(requestCount);

        for (let i = 0; i < requestCount; i++) {
          const encodedRequest = events[i].args[0];
          // 0x (2 characters) + 48-byte pubkey (96 characters) + 8-byte amount (16 characters) = 114 characters
          expect(encodedRequest.length).to.equal(114);

          expect(normalize(encodedRequest.substring(0, 98))).to.equal(normalize(expectedPubKeys[i]));
          expect(normalize(encodedRequest.substring(98, 114))).to.equal(
            expectedAmounts[i].toString(16).padStart(16, "0"),
          );
        }
      };

      await testEncoding(
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee),
        pubkeys,
        fullWithdrawalAmounts,
      );
      await testEncoding(
        () => triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
        pubkeys,
        partialWithdrawalAmounts,
      );
      await testEncoding(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee),
        pubkeys,
        mixedWithdrawalAmounts,
      );
    });

    async function addWithdrawalRequests(
      addRequests: () => Promise<ContractTransactionResponse>,
      expectedPubkeys: string[],
      expectedAmounts: bigint[],
      expectedTotalWithdrawalFee: bigint,
    ) {
      const initialBalance = await getWithdrawalCredentialsContractBalance();

      const tx = await addRequests();

      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance - expectedTotalWithdrawalFee);

      const receipt = await tx.wait();

      const events = findEvents(receipt!, "WithdrawalRequestAdded");
      expect(events.length).to.equal(expectedPubkeys.length);

      for (let i = 0; i < expectedPubkeys.length; i++) {
        expect(events[i].args[0]).to.equal(expectedPubkeys[i]);
        expect(events[i].args[1]).to.equal(expectedAmounts[i]);
      }

      const eip7002TriggerableWithdrawalMockEvents = findEip7002TriggerableWithdrawalMockEvents(
        receipt!,
        "eip7002WithdrawalRequestAdded",
      );
      expect(eip7002TriggerableWithdrawalMockEvents.length).to.equal(expectedPubkeys.length);
      for (let i = 0; i < expectedPubkeys.length; i++) {
        expect(eip7002TriggerableWithdrawalMockEvents[i].args[0]).to.equal(
          expectedPubkeys[i].concat(expectedAmounts[i].toString(16).padStart(16, "0")),
        );
      }
    }

    const testCasesForWithdrawalRequests = [
      { requestCount: 1, fee: 0n },
      { requestCount: 1, fee: 100n },
      { requestCount: 1, fee: 100_000_000_000n },
      { requestCount: 3, fee: 0n },
      { requestCount: 3, fee: 1n },
      { requestCount: 7, fee: 3n },
      { requestCount: 10, fee: 0n },
      { requestCount: 10, fee: 100_000_000_000n },
      { requestCount: 100, fee: 0n },
    ];

    testCasesForWithdrawalRequests.forEach(({ requestCount, fee }) => {
      it(`Should successfully add ${requestCount} requests with fee ${fee} and emit events`, async () => {
        const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
          generateWithdrawalRequestPayload(requestCount);

        const requestFee = fee == 0n ? await getFee() : fee;
        const expectedTotalWithdrawalFee = requestFee * BigInt(requestCount);

        await addWithdrawalRequests(
          () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee),
          pubkeys,
          fullWithdrawalAmounts,
          expectedTotalWithdrawalFee,
        );

        await addWithdrawalRequests(
          () => triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
          pubkeys,
          partialWithdrawalAmounts,
          expectedTotalWithdrawalFee,
        );

        await addWithdrawalRequests(
          () => triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee),
          pubkeys,
          mixedWithdrawalAmounts,
          expectedTotalWithdrawalFee,
        );
      });
    });
  });
});
