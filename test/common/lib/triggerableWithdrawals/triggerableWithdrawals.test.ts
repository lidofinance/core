import { expect } from "chai";
import { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { EIP7002WithdrawalRequest_Mock, TriggerableWithdrawals_Harness } from "typechain-types";

import { Snapshot } from "test/suite";

import { findEip7002MockEvents, testEip7002Mock } from "./eip7002Mock";
import {
  deployWithdrawalsPredeployedMock,
  generateWithdrawalRequestPayload,
  withdrawalsPredeployedHardcodedAddress,
} from "./utils";

const EMPTY_PUBKEYS = "0x";

describe("TriggerableWithdrawals.sol", () => {
  let actor: HardhatEthersSigner;

  let withdrawalsPredeployed: EIP7002WithdrawalRequest_Mock;
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
      await expect(triggerableWithdrawals.addFullWithdrawalRequests(EMPTY_PUBKEYS, 1n)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "NoWithdrawalRequests",
      );

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(EMPTY_PUBKEYS, [], 1n),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "NoWithdrawalRequests");

      await expect(triggerableWithdrawals.addWithdrawalRequests(EMPTY_PUBKEYS, [], 1n)).to.be.revertedWithCustomError(
        triggerableWithdrawals,
        "NoWithdrawalRequests",
      );
    });

    it("Should revert if array lengths do not match", async function () {
      const requestCount = 2;
      const { pubkeysHexString } = generateWithdrawalRequestPayload(requestCount);
      const amounts = [1n];

      const fee = await getFee();

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, amounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(requestCount, amounts.length);

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, [], fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(requestCount, 0);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, amounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(requestCount, amounts.length);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, [], fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "MismatchedArrayLengths")
        .withArgs(requestCount, 0);
    });

    it("Should revert if not enough fee is sent", async function () {
      const { pubkeysHexString } = generateWithdrawalRequestPayload(1);
      const amounts = [10n];

      await withdrawalsPredeployed.setFee(3n); // Set fee to 3 gwei

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, insufficientFee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientRequestFee")
        .withArgs(2n, 3n);

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, amounts, insufficientFee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientRequestFee")
        .withArgs(2n, 3n);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, amounts, insufficientFee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientRequestFee")
        .withArgs(2n, 3n);
    });

    it("Should revert if pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const invalidPubkeyHexString = "0x1234";
      const amounts = [10n];

      const fee = await getFee();

      await expect(
        triggerableWithdrawals.addFullWithdrawalRequests(invalidPubkeyHexString, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPublicKeyLength");

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(invalidPubkeyHexString, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPublicKeyLength");

      await expect(
        triggerableWithdrawals.addWithdrawalRequests(invalidPubkeyHexString, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPublicKeyLength");
    });

    it("Should revert if last pubkey not 48 bytes", async function () {
      const validPubey =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";
      const invalidPubkey = "1234";
      const pubkeysHexString = `0x${validPubey}${invalidPubkey}`;

      const amounts = [10n];

      const fee = await getFee();

      await expect(
        triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPublicKeyLength");

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPublicKeyLength");

      await expect(
        triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "InvalidPublicKeyLength");
    });

    it("Should revert if addition fails at the withdrawal request contract", async function () {
      const { pubkeysHexString } = generateWithdrawalRequestPayload(1);
      const amounts = [10n];

      const fee = await getFee();

      // Set mock to fail on add
      await withdrawalsPredeployed.setFailOnAddRequest(true);

      await expect(
        triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestAdditionFailed");

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestAdditionFailed");

      await expect(
        triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestAdditionFailed");
    });

    it("Should revert when a full withdrawal amount is included in 'addPartialWithdrawalRequests'", async function () {
      const { pubkeysHexString } = generateWithdrawalRequestPayload(2);
      const amounts = [1n, 0n]; // Partial and Full withdrawal
      const fee = await getFee();

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, amounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "PartialWithdrawalRequired");
    });

    it("Should revert when balance is less than total withdrawal fee", async function () {
      const keysCount = 2;
      const fee = 10n;
      const balance = 19n;
      const expectedMinimalBalance = 20n;

      const { pubkeysHexString, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(keysCount);

      await withdrawalsPredeployed.setFee(fee);
      await setBalance(await triggerableWithdrawals.getAddress(), balance);

      await expect(triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, expectedMinimalBalance);

      await expect(triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, expectedMinimalBalance);

      await expect(triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee))
        .to.be.revertedWithCustomError(triggerableWithdrawals, "InsufficientBalance")
        .withArgs(balance, expectedMinimalBalance);
    });

    it("Should revert when fee read fails", async function () {
      await withdrawalsPredeployed.setFailOnGetFee(true);

      const { pubkeysHexString, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(2);
      const fee = 10n;

      await expect(
        triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestFeeReadFailed");

      await expect(
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestFeeReadFailed");

      await expect(
        triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee),
      ).to.be.revertedWithCustomError(triggerableWithdrawals, "WithdrawalRequestFeeReadFailed");
    });

    it("Should accept withdrawal requests with minimal possible fee when fee not provided", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      const fee_not_provided = 0n;
      await withdrawalsPredeployed.setFee(fee);

      await testEip7002Mock(
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee_not_provided),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      await testEip7002Mock(
        () =>
          triggerableWithdrawals.addPartialWithdrawalRequests(
            pubkeysHexString,
            partialWithdrawalAmounts,
            fee_not_provided,
          ),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );

      await testEip7002Mock(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee_not_provided),
        pubkeys,
        mixedWithdrawalAmounts,
        fee,
      );
    });

    it("Should accept withdrawal requests when the provided fee matches the exact required amount", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      await withdrawalsPredeployed.setFee(fee);

      await testEip7002Mock(
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee),
        pubkeys,
        fullWithdrawalAmounts,
        fee,
      );

      await testEip7002Mock(
        () => triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, fee),
        pubkeys,
        partialWithdrawalAmounts,
        fee,
      );

      await testEip7002Mock(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee),
        pubkeys,
        mixedWithdrawalAmounts,
        fee,
      );

      // Check extremely high fee
      const highFee = ethers.parseEther("10");
      await withdrawalsPredeployed.setFee(highFee);

      await triggerableWithdrawals.connect(actor).deposit({ value: highFee * BigInt(requestCount) * 3n });

      await testEip7002Mock(
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, highFee),
        pubkeys,
        fullWithdrawalAmounts,
        highFee,
      );

      await testEip7002Mock(
        () => triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, highFee),
        pubkeys,
        partialWithdrawalAmounts,
        highFee,
      );

      await testEip7002Mock(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, highFee),
        pubkeys,
        mixedWithdrawalAmounts,
        highFee,
      );
    });

    it("Should accept withdrawal requests when the provided fee exceeds the required amount", async function () {
      const requestCount = 3;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const excessFee = 4n;

      await testEip7002Mock(
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, excessFee),
        pubkeys,
        fullWithdrawalAmounts,
        excessFee,
      );

      await testEip7002Mock(
        () =>
          triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, excessFee),
        pubkeys,
        partialWithdrawalAmounts,
        excessFee,
      );

      await testEip7002Mock(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, excessFee),
        pubkeys,
        mixedWithdrawalAmounts,
        excessFee,
      );

      // Check when the provided fee extremely exceeds the required amount
      const extremelyHighFee = ethers.parseEther("10");
      await triggerableWithdrawals.connect(actor).deposit({ value: extremelyHighFee * BigInt(requestCount) * 3n });

      await testEip7002Mock(
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, extremelyHighFee),
        pubkeys,
        fullWithdrawalAmounts,
        extremelyHighFee,
      );

      await testEip7002Mock(
        () =>
          triggerableWithdrawals.addPartialWithdrawalRequests(
            pubkeysHexString,
            partialWithdrawalAmounts,
            extremelyHighFee,
          ),
        pubkeys,
        partialWithdrawalAmounts,
        extremelyHighFee,
      );

      await testEip7002Mock(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, extremelyHighFee),
        pubkeys,
        mixedWithdrawalAmounts,
        extremelyHighFee,
      );
    });

    it("Should correctly deduct the exact fee amount from the contract balance", async function () {
      const requestCount = 3;
      const { pubkeysHexString, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 4n;
      const expectedTotalWithdrawalFee = 12n; // fee * requestCount;

      const testFeeDeduction = async (addRequests: () => Promise<ContractTransactionResponse>) => {
        const initialBalance = await getWithdrawalCredentialsContractBalance();
        await addRequests();
        expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance - expectedTotalWithdrawalFee);
      };

      await testFeeDeduction(() => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee));
      await testFeeDeduction(() =>
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, fee),
      );
      await testFeeDeduction(() =>
        triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee),
      );
    });

    it("Should transfer the total calculated fee to the EIP-7002 withdrawal contract", async function () {
      const requestCount = 3;
      const { pubkeysHexString, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 3n;
      const expectedTotalWithdrawalFee = 9n; // fee * requestCount;

      const testFeeTransfer = async (addRequests: () => Promise<ContractTransactionResponse>) => {
        const initialBalance = await getWithdrawalsPredeployedContractBalance();
        await addRequests();
        expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);
      };

      await testFeeTransfer(() => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee));
      await testFeeTransfer(() =>
        triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, fee),
      );
      await testFeeTransfer(() =>
        triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee),
      );
    });

    it("Should accept full, partial, and mixed withdrawal requests via 'addWithdrawalRequests' function", async function () {
      const { pubkeysHexString, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(3);
      const fee = await getFee();

      await triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, fullWithdrawalAmounts, fee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, fee);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee);
    });

    it("Should handle maximum uint64 withdrawal amount in partial withdrawal requests", async function () {
      const { pubkeysHexString } = generateWithdrawalRequestPayload(1);
      const amounts = [MAX_UINT64];

      await triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, amounts, 10n);
      await triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, amounts, 10n);
    });

    it("Should ensure withdrawal requests are encoded as expected with a 48-byte pubkey and 8-byte amount", async function () {
      const requestCount = 16;
      const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
        generateWithdrawalRequestPayload(requestCount);

      const fee = 333n;

      const testEncoding = async (
        addRequests: () => Promise<ContractTransactionResponse>,
        expectedPubKeys: string[],
        expectedAmounts: bigint[],
      ) => {
        const tx = await addRequests();
        const receipt = await tx.wait();

        const events = findEip7002MockEvents(receipt!, "eip7002MockRequestAdded");
        expect(events.length).to.equal(requestCount);

        for (let i = 0; i < requestCount; i++) {
          const encodedRequest = events[i].args[0];
          // 0x (2 characters) + 48-byte pubkey (96 characters) + 8-byte amount (16 characters) = 114 characters
          expect(encodedRequest.length).to.equal(114);

          expect(encodedRequest.slice(0, 2)).to.equal("0x");
          expect(encodedRequest.slice(2, 98)).to.equal(expectedPubKeys[i]);
          expect(encodedRequest.slice(98, 114)).to.equal(expectedAmounts[i].toString(16).padStart(16, "0"));

          // double check the amount convertation
          expect(BigInt("0x" + encodedRequest.slice(98, 114))).to.equal(expectedAmounts[i]);
        }
      };

      await testEncoding(
        () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee),
        pubkeys,
        fullWithdrawalAmounts,
      );
      await testEncoding(
        () => triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, fee),
        pubkeys,
        partialWithdrawalAmounts,
      );
      await testEncoding(
        () => triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee),
        pubkeys,
        mixedWithdrawalAmounts,
      );
    });

    async function addWithdrawalRequests(
      addRequests: () => Promise<ContractTransactionResponse>,
      expectedPubkeys: string[],
      expectedAmounts: bigint[],
      expectedFee: bigint,
      expectedTotalWithdrawalFee: bigint,
    ) {
      const initialBalance = await getWithdrawalCredentialsContractBalance();

      await testEip7002Mock(addRequests, expectedPubkeys, expectedAmounts, expectedFee);

      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance - expectedTotalWithdrawalFee);
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
      it(`Should successfully add ${requestCount} requests with fee ${fee}`, async () => {
        const { pubkeysHexString, pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts } =
          generateWithdrawalRequestPayload(requestCount);

        const expectedFee = fee == 0n ? await getFee() : fee;
        const expectedTotalWithdrawalFee = expectedFee * BigInt(requestCount);

        await addWithdrawalRequests(
          () => triggerableWithdrawals.addFullWithdrawalRequests(pubkeysHexString, fee),
          pubkeys,
          fullWithdrawalAmounts,
          expectedFee,
          expectedTotalWithdrawalFee,
        );

        await addWithdrawalRequests(
          () => triggerableWithdrawals.addPartialWithdrawalRequests(pubkeysHexString, partialWithdrawalAmounts, fee),
          pubkeys,
          partialWithdrawalAmounts,
          expectedFee,
          expectedTotalWithdrawalFee,
        );

        await addWithdrawalRequests(
          () => triggerableWithdrawals.addWithdrawalRequests(pubkeysHexString, mixedWithdrawalAmounts, fee),
          pubkeys,
          mixedWithdrawalAmounts,
          expectedFee,
          expectedTotalWithdrawalFee,
        );
      });
    });
  });
});
