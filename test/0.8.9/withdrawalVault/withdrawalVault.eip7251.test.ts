import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  EIP7251ConsolidationRequest__Mock,
  Lido__MockForWithdrawalVault,
  WithdrawalVault__Harness,
} from "typechain-types";

import { deployEIP7251WithdrawalRequestContract, EIP7251_ADDRESS, proxify, streccak } from "lib";

import { Snapshot } from "test/suite";

import { encodeEIP7251Payload, findEIP7251MockEvents, testEIP7251Mock } from "./eip7251Mock";
import { generateConsolidationRequestPayload } from "./utils";

const ADD_CONSOLIDATION_REQUEST_ROLE = streccak("ADD_CONSOLIDATION_REQUEST_ROLE");

describe("WithdrawalVault.sol:eip7251 Consolidation Requests", () => {
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let validatorsExitBus: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  let lido: Lido__MockForWithdrawalVault;
  let lidoAddress: string;

  let consolidationPredeployed: EIP7251ConsolidationRequest__Mock;

  let impl: WithdrawalVault__Harness;
  let vault: WithdrawalVault__Harness;

  async function getFee(): Promise<bigint> {
    const fee = await vault.getConsolidationRequestFee();

    return ethers.parseUnits(fee.toString(), "wei");
  }

  async function getWithdrawalConsolidationContractBalance(): Promise<bigint> {
    const contractAddress = await vault.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  async function getConsalidationsPredeployedContractBalance(): Promise<bigint> {
    const contractAddress = await consolidationPredeployed.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  before(async () => {
    [owner, treasury, validatorsExitBus, stranger] = await ethers.getSigners();

    consolidationPredeployed = await deployEIP7251WithdrawalRequestContract(1n);

    expect(await consolidationPredeployed.getAddress()).to.equal(EIP7251_ADDRESS);

    lido = await ethers.deployContract("Lido__MockForWithdrawalVault");
    lidoAddress = await lido.getAddress();

    impl = await ethers.deployContract("WithdrawalVault__Harness", [lidoAddress, treasury.address], owner);

    [vault] = await proxify({ impl, admin: owner });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("get consolidation request fee", () => {
    it("Should get fee from the EIP 7251 contract", async function () {
      await consolidationPredeployed.mock__setFee(333n);
      expect(
        (await vault.getConsolidationRequestFee()) == 333n,
        "consolidation request should use fee from the EIP 7251 contract",
      );
    });

    it("Should revert if fee read fails", async function () {
      await consolidationPredeployed.mock__setFailOnGetFee(true);
      await expect(vault.getConsolidationRequestFee()).to.be.revertedWithCustomError(vault, "FeeReadFailed");
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Shoud revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await consolidationPredeployed.mock__setFeeRaw(unexpectedFee);

        await expect(vault.getConsolidationRequestFee()).to.be.revertedWithCustomError(vault, "FeeInvalidData");
      });
    });
  });

  context("add consolidation requests", () => {
    beforeEach(async () => {
      await vault.initialize(owner);
      await vault.connect(owner).grantRole(ADD_CONSOLIDATION_REQUEST_ROLE, validatorsExitBus);
    });

    it("Should revert if the caller is not Validator Exit Bus", async () => {
      await expect(
        vault.connect(stranger).addConsolidationRequests("0x1234", "0x1234"),
      ).to.be.revertedWithOZAccessControlError(stranger.address, ADD_CONSOLIDATION_REQUEST_ROLE);
    });

    it("Should revert if empty arrays are provided", async function () {
      await expect(vault.connect(validatorsExitBus).addConsolidationRequests("0x", "0x1234", { value: 1n }))
        .to.be.revertedWithCustomError(vault, "ZeroArgument")
        .withArgs("sourcePubkeys");
    });

    it("Should revert if array lengths do not match", async function () {
      const { sourcePubkeysHexString } = generateConsolidationRequestPayload(2);
      const { targetPubkeysHexString } = generateConsolidationRequestPayload(1);

      await expect(
        vault
          .connect(validatorsExitBus)
          .addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, { value: 1n }),
      )
        .to.be.revertedWithCustomError(vault, "ArraysLengthMismatch")
        .withArgs(96, 48);

      await expect(
        vault.connect(validatorsExitBus).addConsolidationRequests(sourcePubkeysHexString, "0x", { value: 1n }),
      )
        .to.be.revertedWithCustomError(vault, "ArraysLengthMismatch")
        .withArgs(96, 0);
    });

    it("Should revert if not enough fee is sent", async function () {
      const { sourcePubkeysHexString, targetPubkeysHexString } = generateConsolidationRequestPayload(1);

      await consolidationPredeployed.mock__setFee(3n); // Set fee to 3 gwei

      // 1. Should revert if no fee is sent
      await expect(
        vault.connect(validatorsExitBus).addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString),
      )
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(0, 3n);

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(
        vault
          .connect(validatorsExitBus)
          .addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, { value: insufficientFee }),
      )
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(2n, 3n);
    });

    it("Should revert if pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const invalidPubkeyHexString = "0x1234";

      const fee = await getFee();
      await expect(
        vault
          .connect(validatorsExitBus)
          .addConsolidationRequests(invalidPubkeyHexString, invalidPubkeyHexString, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "MalformedPubkeysArray");
    });

    it("Should revert if last pubkey not 48 bytes", async function () {
      const validPubey =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";
      const invalidPubkey = "1234";
      const pubkeysHexString = `0x${validPubey}${invalidPubkey}`;

      const fee = await getFee();

      await expect(
        vault.connect(validatorsExitBus).addConsolidationRequests(pubkeysHexString, pubkeysHexString, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "MalformedPubkeysArray");
    });

    it("Should revert if addition fails at the consolidation request contract", async function () {
      const { sourcePubkeysHexString, targetPubkeysHexString } = generateConsolidationRequestPayload(1);
      const fee = await getFee();

      // Set mock to fail on add
      await consolidationPredeployed.mock__setFailOnAddRequest(true);

      await expect(
        vault
          .connect(validatorsExitBus)
          .addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "RequestAdditionFailed");
    });

    it("Should revert when fee read fails", async function () {
      await consolidationPredeployed.mock__setFailOnGetFee(true);

      const { sourcePubkeysHexString, targetPubkeysHexString } = generateConsolidationRequestPayload(2);
      const fee = 10n;

      await expect(
        vault
          .connect(validatorsExitBus)
          .addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "FeeReadFailed");
    });

    it("Should revert when the provided fee exceeds the required amount", async function () {
      const requestCount = 3;
      const { sourcePubkeysHexString, targetPubkeysHexString } = generateConsolidationRequestPayload(requestCount);

      const fee = 3n;
      await consolidationPredeployed.mock__setFee(fee);
      const totalFee = 9n + 1n; // 3 request * 3 gwei (fee) + 1 gwei (extra fee)= 10 gwei

      await expect(
        vault
          .connect(validatorsExitBus)
          .addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, { value: totalFee }),
      )
        .to.be.revertedWithCustomError(vault, "IncorrectFee")
        .withArgs(10n, 9n);
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Should revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await consolidationPredeployed.mock__setFeeRaw(unexpectedFee);

        const { sourcePubkeysHexString, targetPubkeysHexString } = generateConsolidationRequestPayload(2);
        const fee = 10n;

        await expect(
          vault
            .connect(validatorsExitBus)
            .addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, { value: fee }),
        ).to.be.revertedWithCustomError(vault, "FeeInvalidData");
      });
    });

    it("Should accept consolidation requests when the provided fee matches the exact required amount", async function () {
      const requestCount = 3;
      const { sourcePubkeysHexString, sourcePubkeys, targetPubkeysHexString, targetPubkeys } =
        generateConsolidationRequestPayload(requestCount);

      const fee = 3n;
      await consolidationPredeployed.mock__setFee(3n);
      const expectedTotalFee = 9n;

      await testEIP7251Mock(
        () =>
          vault.connect(validatorsExitBus).addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, {
            value: expectedTotalFee,
          }),
        sourcePubkeys,
        targetPubkeys,
        fee,
      );

      // Check extremely high fee
      const highFee = ethers.parseEther("10");
      await consolidationPredeployed.mock__setFee(highFee);
      const expectedLargeTotalFee = ethers.parseEther("30");

      await testEIP7251Mock(
        () =>
          vault.connect(validatorsExitBus).addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, {
            value: expectedLargeTotalFee,
          }),
        sourcePubkeys,
        targetPubkeys,
        highFee,
      );
    });

    it("Should emit consolidation event", async function () {
      const requestCount = 3;
      const { sourcePubkeysHexString, sourcePubkeys, targetPubkeysHexString, targetPubkeys } =
        generateConsolidationRequestPayload(requestCount);

      const fee = 3n;
      await consolidationPredeployed.mock__setFee(fee);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      await expect(
        vault.connect(validatorsExitBus).addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, {
          value: expectedTotalWithdrawalFee,
        }),
      )
        .to.emit(vault, "ConsolidationRequestAdded")
        .withArgs(encodeEIP7251Payload(sourcePubkeys[0], targetPubkeys[0]))
        .and.to.emit(vault, "ConsolidationRequestAdded")
        .withArgs(encodeEIP7251Payload(sourcePubkeys[1], targetPubkeys[1]))
        .and.to.emit(vault, "ConsolidationRequestAdded")
        .withArgs(encodeEIP7251Payload(sourcePubkeys[2], targetPubkeys[2]));
    });

    it("Should not affect contract balance", async function () {
      const requestCount = 3;
      const { sourcePubkeysHexString, sourcePubkeys, targetPubkeysHexString, targetPubkeys } =
        generateConsolidationRequestPayload(requestCount);

      const fee = 3n;
      await consolidationPredeployed.mock__setFee(fee);
      const expectedTotalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      const initialBalance = await getWithdrawalConsolidationContractBalance();

      await testEIP7251Mock(
        () =>
          vault.connect(validatorsExitBus).addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, {
            value: expectedTotalFee,
          }),
        sourcePubkeys,
        targetPubkeys,
        fee,
      );
      expect(await getWithdrawalConsolidationContractBalance()).to.equal(initialBalance);
    });

    it("Should transfer the total calculated fee to the EIP-7251 consolidation contract", async function () {
      const requestCount = 3;
      const { sourcePubkeysHexString, sourcePubkeys, targetPubkeysHexString, targetPubkeys } =
        generateConsolidationRequestPayload(requestCount);

      const fee = 3n;
      await consolidationPredeployed.mock__setFee(3n);
      const expectedTotalFee = 9n;

      const initialBalance = await getConsalidationsPredeployedContractBalance();
      await testEIP7251Mock(
        () =>
          vault.connect(validatorsExitBus).addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, {
            value: expectedTotalFee,
          }),
        sourcePubkeys,
        targetPubkeys,
        fee,
      );

      expect(await getConsalidationsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalFee);
    });

    it("Should ensure consolidation requests are encoded as expected with a 48-byte pubkey and 8-byte amount", async function () {
      const requestCount = 16;
      const { sourcePubkeysHexString, sourcePubkeys, targetPubkeysHexString, targetPubkeys } =
        generateConsolidationRequestPayload(requestCount);

      const tx = await vault
        .connect(validatorsExitBus)
        .addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, { value: 16n });

      const receipt = await tx.wait();

      const events = findEIP7251MockEvents(receipt!);
      expect(events.length).to.equal(requestCount);

      for (let i = 0; i < requestCount; i++) {
        const encodedRequest = events[i].args[0];
        // 0x (2 characters) + 48-byte pubkey (96 characters) + 48-byte pubkey (96 characters) = 194 characters
        expect(encodedRequest.length).to.equal(194);

        expect(encodedRequest.slice(0, 2)).to.equal("0x");
        expect(encodedRequest.slice(2, 98)).to.equal(sourcePubkeys[i]);
        expect(encodedRequest.slice(98, 194)).to.equal(targetPubkeys[i]);
      }
    });

    const testCasesForConsolidationRequests = [
      { requestCount: 1 },
      { requestCount: 3 },
      { requestCount: 7 },
      { requestCount: 10 },
      { requestCount: 100 },
    ];

    testCasesForConsolidationRequests.forEach(({ requestCount }) => {
      it(`Should successfully add ${requestCount} requests`, async () => {
        const { sourcePubkeysHexString, sourcePubkeys, targetPubkeysHexString, targetPubkeys } =
          generateConsolidationRequestPayload(requestCount);
        const expectedFee = await getFee();
        const expectedTotalFee = expectedFee * BigInt(requestCount);

        const initialBalance = await getWithdrawalConsolidationContractBalance();
        const vebInitialBalance = await ethers.provider.getBalance(validatorsExitBus.address);

        const { receipt: receiptPartialWithdrawal } = await testEIP7251Mock(
          () =>
            vault.connect(validatorsExitBus).addConsolidationRequests(sourcePubkeysHexString, targetPubkeysHexString, {
              value: expectedTotalFee,
            }),
          sourcePubkeys,
          targetPubkeys,
          expectedFee,
        );

        expect(await getWithdrawalConsolidationContractBalance()).to.equal(initialBalance);
        expect(await ethers.provider.getBalance(validatorsExitBus.address)).to.equal(
          vebInitialBalance - expectedTotalFee - receiptPartialWithdrawal.gasUsed * receiptPartialWithdrawal.gasPrice,
        );
      });
    });
  });
});
