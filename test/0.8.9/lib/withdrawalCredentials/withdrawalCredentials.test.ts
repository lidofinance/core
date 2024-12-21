import { expect } from "chai";
import { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { WithdrawalCredentials_Harness, WithdrawalsPredeployed_Mock } from "typechain-types";

import { Snapshot } from "test/suite";

import { findEvents } from "./findEvents";
import {
  deployWithdrawalsPredeployedMock,
  generateWithdrawalRequestPayload,
  withdrawalsPredeployedHardcodedAddress,
} from "./withdrawalRequests.behavior";

describe("WithdrawalCredentials.sol", () => {
  let actor: HardhatEthersSigner;

  let withdrawalsPredeployed: WithdrawalsPredeployed_Mock;
  let withdrawalCredentials: WithdrawalCredentials_Harness;

  let originalState: string;

  async function getWithdrawalCredentialsContractBalance(): Promise<bigint> {
    const contractAddress = await withdrawalCredentials.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  async function getWithdrawalsPredeployedContractBalance(): Promise<bigint> {
    const contractAddress = await withdrawalsPredeployed.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  before(async () => {
    [actor] = await ethers.getSigners();

    withdrawalsPredeployed = await deployWithdrawalsPredeployedMock(1n);
    withdrawalCredentials = await ethers.deployContract("WithdrawalCredentials_Harness");

    expect(await withdrawalsPredeployed.getAddress()).to.equal(withdrawalsPredeployedHardcodedAddress);

    await withdrawalCredentials.connect(actor).deposit({ value: ethers.parseEther("1") });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  async function getFee(requestsCount: number): Promise<bigint> {
    const fee = await withdrawalCredentials.getWithdrawalRequestFee();

    return ethers.parseUnits((fee * BigInt(requestsCount)).toString(), "wei");
  }

  context("eip 7002 contract", () => {
    it("Should return the address of the EIP 7002 contract", async function () {
      expect(await withdrawalCredentials.getWithdrawalsContractAddress()).to.equal(
        withdrawalsPredeployedHardcodedAddress,
      );
    });
  });

  context("get withdrawal request fee", () => {
    it("Should get fee from the EIP 7002 contract", async function () {
      await withdrawalsPredeployed.setFee(333n);
      expect(
        (await withdrawalCredentials.getWithdrawalRequestFee()) == 333n,
        "withdrawal request should use fee from the EIP 7002 contract",
      );
    });

    it("Should revert if fee read fails", async function () {
      await withdrawalsPredeployed.setFailOnGetFee(true);
      await expect(withdrawalCredentials.getWithdrawalRequestFee()).to.be.revertedWithCustomError(
        withdrawalCredentials,
        "WithdrawalRequestFeeReadFailed",
      );
    });
  });

  context("add withdrawal requests", () => {
    it("Should revert if empty arrays are provided", async function () {
      await expect(withdrawalCredentials.addFullWithdrawalRequests([], 1n)).to.be.revertedWithCustomError(
        withdrawalCredentials,
        "NoWithdrawalRequests",
      );

      await expect(withdrawalCredentials.addPartialWithdrawalRequests([], [], 1n)).to.be.revertedWithCustomError(
        withdrawalCredentials,
        "NoWithdrawalRequests",
      );

      await expect(withdrawalCredentials.addWithdrawalRequests([], [], 1n)).to.be.revertedWithCustomError(
        withdrawalCredentials,
        "NoWithdrawalRequests",
      );
    });

    it("Should revert if array lengths do not match", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(2);
      const amounts = [1n];

      const fee = await getFee(pubkeys.length);

      await expect(withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, amounts, fee))
        .to.be.revertedWithCustomError(withdrawalCredentials, "MismatchedArrayLengths")
        .withArgs(pubkeys.length, amounts.length);

      await expect(withdrawalCredentials.addWithdrawalRequests(pubkeys, amounts, fee))
        .to.be.revertedWithCustomError(withdrawalCredentials, "MismatchedArrayLengths")
        .withArgs(pubkeys.length, amounts.length);
    });

    it("Should revert if not enough fee is sent", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(1);
      const amounts = [10n];

      await withdrawalsPredeployed.setFee(3n); // Set fee to 3 gwei

      // 1. Should revert if no fee is sent
      await expect(withdrawalCredentials.addFullWithdrawalRequests(pubkeys, 0n)).to.be.revertedWithCustomError(
        withdrawalCredentials,
        "FeeNotEnough",
      );

      await expect(
        withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, amounts, 0n),
      ).to.be.revertedWithCustomError(withdrawalCredentials, "FeeNotEnough");

      await expect(withdrawalCredentials.addWithdrawalRequests(pubkeys, amounts, 0n)).to.be.revertedWithCustomError(
        withdrawalCredentials,
        "FeeNotEnough",
      );

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(
        withdrawalCredentials.addFullWithdrawalRequests(pubkeys, insufficientFee),
      ).to.be.revertedWithCustomError(withdrawalCredentials, "FeeNotEnough");

      await expect(
        withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, amounts, insufficientFee),
      ).to.be.revertedWithCustomError(withdrawalCredentials, "FeeNotEnough");

      await expect(
        withdrawalCredentials.addWithdrawalRequests(pubkeys, amounts, insufficientFee),
      ).to.be.revertedWithCustomError(withdrawalCredentials, "FeeNotEnough");
    });

    it("Should revert if any pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const pubkeys = ["0x1234"];
      const amounts = [10n];

      const fee = await getFee(pubkeys.length);

      await expect(withdrawalCredentials.addFullWithdrawalRequests(pubkeys, fee))
        .to.be.revertedWithCustomError(withdrawalCredentials, "InvalidPubkeyLength")
        .withArgs(pubkeys[0]);

      await expect(withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, amounts, fee))
        .to.be.revertedWithCustomError(withdrawalCredentials, "InvalidPubkeyLength")
        .withArgs(pubkeys[0]);

      await expect(withdrawalCredentials.addWithdrawalRequests(pubkeys, amounts, fee))
        .to.be.revertedWithCustomError(withdrawalCredentials, "InvalidPubkeyLength")
        .withArgs(pubkeys[0]);
    });

    it("Should revert if addition fails at the withdrawal request contract", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(1);
      const amounts = [10n];

      const fee = await getFee(pubkeys.length);

      // Set mock to fail on add
      await withdrawalsPredeployed.setFailOnAddRequest(true);

      await expect(withdrawalCredentials.addFullWithdrawalRequests(pubkeys, fee)).to.be.revertedWithCustomError(
        withdrawalCredentials,
        "WithdrawalRequestAdditionFailed",
      );

      await expect(
        withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, amounts, fee),
      ).to.be.revertedWithCustomError(withdrawalCredentials, "WithdrawalRequestAdditionFailed");

      await expect(withdrawalCredentials.addWithdrawalRequests(pubkeys, amounts, fee)).to.be.revertedWithCustomError(
        withdrawalCredentials,
        "WithdrawalRequestAdditionFailed",
      );
    });

    it("Should revert if full withdrawal requested in 'addPartialWithdrawalRequests'", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(2);
      const amounts = [1n, 0n]; // Partial and Full withdrawal
      const fee = await getFee(pubkeys.length);

      await expect(
        withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, amounts, fee),
      ).to.be.revertedWithCustomError(withdrawalCredentials, "PartialWithdrawalRequired");
    });

    it("Should revert if contract balance insufficient'", async function () {
      const { pubkeys, partialWithdrawalAmounts, fullWithdrawalAmounts } = generateWithdrawalRequestPayload(2);
      const fee = 10n;
      const totalWithdrawalFee = 20n;
      const balance = 19n;

      await withdrawalsPredeployed.setFee(fee);
      await setBalance(await withdrawalCredentials.getAddress(), balance);

      await expect(withdrawalCredentials.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee))
        .to.be.revertedWithCustomError(withdrawalCredentials, "InsufficientBalance")
        .withArgs(balance, totalWithdrawalFee);

      await expect(
        withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee),
      )
        .to.be.revertedWithCustomError(withdrawalCredentials, "InsufficientBalance")
        .withArgs(balance, totalWithdrawalFee);

      await expect(withdrawalCredentials.addWithdrawalRequests(pubkeys, fullWithdrawalAmounts, totalWithdrawalFee))
        .to.be.revertedWithCustomError(withdrawalCredentials, "InsufficientBalance")
        .withArgs(balance, totalWithdrawalFee);
    });

    it("Should accept exactly required fee without revert", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const fee = 9n;

      await withdrawalCredentials.addFullWithdrawalRequests(pubkeys, fee);
      await withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee);
      await withdrawalCredentials.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee);
    });

    it("Should accept exceed fee without revert", async function () {
      const requestCount = 3;
      const { pubkeys, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const fee = 9n + 1n; // 3 request * 3 gwei (fee) + 1 gwei (extra fee)= 10 gwei

      await withdrawalCredentials.addFullWithdrawalRequests(pubkeys, fee);
      await withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee);
      await withdrawalCredentials.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee);
    });

    it("Should deduct precise fee value from contract balance", async function () {
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

      await testFeeDeduction(() => withdrawalCredentials.addFullWithdrawalRequests(pubkeys, fee));
      await testFeeDeduction(() =>
        withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
      );
      await testFeeDeduction(() => withdrawalCredentials.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee));
    });

    it("Should send all fee to eip 7002 withdrawal contract", async function () {
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

      await testFeeTransfer(() => withdrawalCredentials.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee));
      await testFeeTransfer(() =>
        withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee),
      );
      await testFeeTransfer(() =>
        withdrawalCredentials.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, totalWithdrawalFee),
      );
    });

    it("should emit a 'WithdrawalRequestAdded' event when a new withdrawal request is added", async function () {
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
        () => withdrawalCredentials.addFullWithdrawalRequests(pubkeys, fee),
        pubkeys,
        fullWithdrawalAmounts,
      );
      await testEventsEmit(
        () => withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee),
        pubkeys,
        partialWithdrawalAmounts,
      );
      await testEventsEmit(
        () => withdrawalCredentials.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee),
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
    }

    const testCasesForWithdrawalRequests = [
      { requestCount: 1, extraFee: 0n },
      { requestCount: 1, extraFee: 100n },
      { requestCount: 3, extraFee: 0n },
      { requestCount: 3, extraFee: 1n },
      { requestCount: 7, extraFee: 3n },
      { requestCount: 10, extraFee: 0n },
      { requestCount: 10, extraFee: 1_000_000n },
      { requestCount: 100, extraFee: 0n },
    ];

    testCasesForWithdrawalRequests.forEach(({ requestCount, extraFee }) => {
      it(`Should successfully add ${requestCount} requests with extra fee ${extraFee} and emit events`, async () => {
        const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
          generateWithdrawalRequestPayload(requestCount);
        const totalWithdrawalFee = (await getFee(pubkeys.length)) + extraFee;

        await addWithdrawalRequests(
          () => withdrawalCredentials.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee),
          pubkeys,
          fullWithdrawalAmounts,
          totalWithdrawalFee,
        );

        await addWithdrawalRequests(
          () =>
            withdrawalCredentials.addPartialWithdrawalRequests(pubkeys, partialWithdrawalAmounts, totalWithdrawalFee),
          pubkeys,
          partialWithdrawalAmounts,
          totalWithdrawalFee,
        );

        await addWithdrawalRequests(
          () => withdrawalCredentials.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, totalWithdrawalFee),
          pubkeys,
          mixedWithdrawalAmounts,
          totalWithdrawalFee,
        );
      });
    });

    it("Should accept full and partial withdrawals requested", async function () {
      const { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(3);
      const fee = await getFee(pubkeys.length);

      await withdrawalCredentials.addWithdrawalRequests(pubkeys, fullWithdrawalAmounts, fee);
      await withdrawalCredentials.addWithdrawalRequests(pubkeys, partialWithdrawalAmounts, fee);
      await withdrawalCredentials.addWithdrawalRequests(pubkeys, mixedWithdrawalAmounts, fee);
    });
  });
});
