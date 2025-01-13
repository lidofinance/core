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

  async function getFee(requestsCount: number): Promise<bigint> {
    const fee = await triggerableWithdrawals.getWithdrawalRequestFee();

    return ethers.parseUnits((fee * BigInt(requestsCount)).toString(), "wei");
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

      const fee = await getFee(pubkeys.length);

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

      // 1. Should revert if no fee is sent
      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, 0n)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "FeeNotEnough",
      );

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, 0n),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "FeeNotEnough");

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, 0n)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "FeeNotEnough",
      );

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(
        triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, insufficientFee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "FeeNotEnough");

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, insufficientFee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "FeeNotEnough");

      await expect(
        triggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, insufficientFee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "FeeNotEnough");
    });

    it("Should revert if any pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const pubkeys = ["0x1234"];
      const amounts = [10n];

      const fee = await getFee(pubkeys.length);

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

      const fee = await getFee(pubkeys.length);

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
      const fee = await getFee(pubkeys.length);

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "PartialWithdrawalRequired");
    });

    it("Should revert when balance is less than total withdrawal fee", async function () {
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
      const fee = 10n;
      const totalWithdrawalFee = 20n;
      const balance = 19n;

      await withdrawalsPredeployed.setFee(fee);
      await setBalance(await triggerableWithdrawals.getAddress(), balance);

      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, totalWithdrawalFee);

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee),
      )
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, totalWithdrawalFee);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, totalWithdrawalFee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, totalWithdrawalFee);
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

    it("Should accept withdrawal requests when the provided fee matches the exact required amount", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const totalWithdrawalFee = 9n;

      await triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee);
      await triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, totalWithdrawalFee);

      // Check extremely high fee
      await withdrawalsPredeployed.setFee(ethers.parseEther("10"));
      const largeTotalWithdrawalFee = ethers.parseEther("30");

      await triggerableWithdrawals.connect(actor).deposit({ value: largeTotalWithdrawalFee * BigInt(requestCount) });

      await triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, largeTotalWithdrawalFee);
      await triggerableWithdrawals.addPartialWithdrawalRequests(
        pubkeys,
        partialWithdrawalAmounts,
        largeTotalWithdrawalFee,
      );
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, largeTotalWithdrawalFee);
    });

    it("Should accept withdrawal requests when the provided fee exceeds the required amount", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const fee = 9n + 1n; // 3 request * 3 gwei (fee) + 1 gwei (extra fee)= 10 gwei

      await triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee);
      await triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee);

      // Check when the provided fee extremely exceeds the required amount
      const largeTotalWithdrawalFee = ethers.parseEther("10");
      await triggerableWithdrawals.connect(actor).deposit({ value: largeTotalWithdrawalFee * BigInt(requestCount) });

      await triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, largeTotalWithdrawalFee);
      await triggerableWithdrawals.addPartialWithdrawalRequests(
        pubkeys,
        partialWithdrawalAmounts,
        largeTotalWithdrawalFee,
      );
      await triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, largeTotalWithdrawalFee);
    });

    it("Should correctly deduct the exact fee amount from the contract balance", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const fee = 9n + 1n; // 3 requests * 3 gwei (fee) + 1 gwei (extra fee) = 10 gwei

      const testFeeDeduction = async (addRequests: () => Promise<ContractTransactionResponse>) => {
        const initialBalance = await getWithdrawalCredentialsContractBalance();
        await addRequests();
        expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance - fee);
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

      await withdrawalsPredeployed.setFee(3n);
      const totalWithdrawalFee = 9n + 1n;

      const testFeeTransfer = async (addRequests: () => Promise<ContractTransactionResponse>) => {
        const initialBalance = await getWithdrawalsPredeployedContractBalance();
        await addRequests();
        expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + totalWithdrawalFee);
      };

      await testFeeTransfer(() => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee));
      await testFeeTransfer(() =>
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee),
      );
      await testFeeTransfer(() =>
        triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, totalWithdrawalFee),
      );
    });

    it("Should accept full, partial, and mixed withdrawal requests via 'addWithdrawalRequests' function", async function () {
      const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(3);
      const fee = await getFee(pubkeys.length);

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
      await withdrawalsPredeployed.setFee(2n);

      const requestCount = 5;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const testFeeDistribution = async (totalWithdrawalFee: bigint, expectedFeePerRequest: bigint[]) => {
        const checkEip7002MockEvents = async (addRequests: () => Promise<ContractTransactionResponse>) => {
          const tx = await addRequests();

          const receipt = await tx.wait();
          const events = findEip7002TriggerableWithdrawalMockEvents(receipt!, "eip7002WithdrawalRequestAdded");
          expect(events.length).to.equal(requestCount);

          for (let i = 0; i < requestCount; i++) {
            expect(events[i].args[1]).to.equal(expectedFeePerRequest[i]);
          }
        };

        await checkEip7002MockEvents(() =>
          triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee),
        );

        await checkEip7002MockEvents(() =>
          triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee),
        );

        await checkEip7002MockEvents(() =>
          triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, totalWithdrawalFee),
        );
      };

      await testFeeDistribution(10n, [2n, 2n, 2n, 2n, 2n]);
      await testFeeDistribution(11n, [2n, 2n, 2n, 2n, 3n]);
      await testFeeDistribution(14n, [2n, 2n, 2n, 2n, 6n]);
      await testFeeDistribution(15n, [3n, 3n, 3n, 3n, 3n]);
    });

    it("Should ensure withdrawal requests are encoded as expected with a 48-byte pubkey and 8-byte amount", async function () {
      const requestCount = 16;
      const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);
      const totalWithdrawalFee = 333n;

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
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee),
        pubkeys,
        fullWithdrawalAmounts,
      );
      await testEncoding(
        () =>
          triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee),
        pubkeys,
        partialWithdrawalAmounts,
      );
      await testEncoding(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, totalWithdrawalFee),
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
      it(`Should successfully add ${requestCount} requests with extra fee ${extraFee} and emit events`, async () => {
        const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
          generateWithdrawalRequestPayload(requestCount);
        const totalWithdrawalFee = (await getFee(pubkeys.length)) + extraFee;

        await addWithdrawalRequests(
          () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee),
          pubkeys,
          fullWithdrawalAmounts,
          totalWithdrawalFee,
        );

        await addWithdrawalRequests(
          () =>
            triggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee),
          pubkeys,
          partialWithdrawalAmounts,
          totalWithdrawalFee,
        );

        await addWithdrawalRequests(
          () => triggerableWithdrawals.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, totalWithdrawalFee),
          pubkeys,
          mixedWithdrawalAmounts,
          totalWithdrawalFee,
        );
      });
    });
  });
});
