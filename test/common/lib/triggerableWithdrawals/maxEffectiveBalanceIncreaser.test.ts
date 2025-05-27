import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { EIP7251MaxEffectiveBalanceRequest__Mock, MaxEffectiveBalanceIncreaser } from "typechain-types";

import { deployEIP7251MaxEffectiveBalanceRequestContract, EIP7251_ADDRESS } from "lib";

import { Snapshot } from "test/suite";

import { findEIP7251MockEvents, testEIP7251Mock } from "./eip7251Mock";
import { generateConsolidationRequestPayload } from "./utils";

const EMPTY_PUBKEYS = "0x";
const KEY_LENGTH = 48;

describe("MaxEffectiveBalanceIncreaser.sol", () => {
  let actor: HardhatEthersSigner;
  let receiver: HardhatEthersSigner;

  let consolidationRequestPredeployed: EIP7251MaxEffectiveBalanceRequest__Mock;
  let maxEffectiveBalanceIncreaser: MaxEffectiveBalanceIncreaser;

  let originalState: string;

  async function getConsolidationRequestPredeployedContractBalance(): Promise<bigint> {
    const contractAddress = await consolidationRequestPredeployed.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  before(async () => {
    [actor, receiver] = await ethers.getSigners();

    // Set a high balance for the actor account
    await setBalance(actor.address, ethers.parseEther("1000000"));

    consolidationRequestPredeployed = await deployEIP7251MaxEffectiveBalanceRequestContract(1n);
    maxEffectiveBalanceIncreaser = await ethers.deployContract("MaxEffectiveBalanceIncreaser");

    expect(await consolidationRequestPredeployed.getAddress()).to.equal(EIP7251_ADDRESS);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  async function getFee(): Promise<bigint> {
    return await maxEffectiveBalanceIncreaser.getConsolidationRequestFee();
  }

  context("eip 7251 max effective balance request contract", () => {
    it("Should return the address of the EIP 7251 max effective balance request contract", async function () {
      expect(await maxEffectiveBalanceIncreaser.CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS()).to.equal(EIP7251_ADDRESS);
    });
  });

  context("get consolidation request fee", () => {
    it("Should get fee from the EIP 7251 max effective balance request contract", async function () {
      await consolidationRequestPredeployed.mock__setFee(333n);
      expect(
        (await maxEffectiveBalanceIncreaser.getConsolidationRequestFee()) == 333n,
        "consolidation request should use fee from the EIP 7251 contract",
      );
    });

    it("Should revert if fee read fails", async function () {
      await consolidationRequestPredeployed.mock__setFailOnGetFee(true);
      await expect(maxEffectiveBalanceIncreaser.getConsolidationRequestFee()).to.be.revertedWithCustomError(
        maxEffectiveBalanceIncreaser,
        "ConsolidationFeeReadFailed",
      );
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Shoud revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await consolidationRequestPredeployed.mock__setFeeRaw(unexpectedFee);

        await expect(maxEffectiveBalanceIncreaser.getConsolidationRequestFee()).to.be.revertedWithCustomError(
          maxEffectiveBalanceIncreaser,
          "ConsolidationFeeInvalidData",
        );
      });
    });
  });

  context("add consolidation requests", () => {
    it("Should revert if empty arrays are provided", async function () {
      await expect(maxEffectiveBalanceIncreaser.addConsolidationRequests([], [], receiver.address))
        .to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "ZeroArgument")
        .withArgs("msg.value");

      await expect(maxEffectiveBalanceIncreaser.addConsolidationRequests([], [], receiver.address, { value: 1n }))
        .to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "ZeroArgument")
        .withArgs("sourcePubkeys");

      await expect(
        maxEffectiveBalanceIncreaser.addConsolidationRequests([EMPTY_PUBKEYS], [], receiver.address, { value: 1n }),
      )
        .to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "ZeroArgument")
        .withArgs("targetPubkeys");
    });
  });

  it("Should revert if array lengths do not match", async function () {
    await expect(
      maxEffectiveBalanceIncreaser.addConsolidationRequests(
        [EMPTY_PUBKEYS],
        [EMPTY_PUBKEYS, EMPTY_PUBKEYS],
        receiver.address,
        { value: 1n },
      ),
    )
      .to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "MismatchingSourceAndTargetPubkeysCount")
      .withArgs(1, 2);
  });

  it("Should revert if not enough fee is sent", async function () {
    const { sourcePubkeys, targetPubkeys } = generateConsolidationRequestPayload(1);

    await consolidationRequestPredeployed.mock__setFee(3n); // Set fee to 3 gwei

    // 2. Should revert if fee is less than required
    const insufficientFee = 2n;
    await expect(
      maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
        value: insufficientFee,
      }),
    ).to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "InsufficientValidatorConsolidationFee");
  });

  it("Should revert if pubkey is not 48 bytes", async function () {
    // Invalid pubkey (only 2 bytes)
    const invalidPubkeyHexString = "0x1234";
    const { sourcePubkeys, targetPubkeys } = generateConsolidationRequestPayload(1);

    const fee = await getFee();

    await expect(
      maxEffectiveBalanceIncreaser.addConsolidationRequests([invalidPubkeyHexString], targetPubkeys, receiver.address, {
        value: fee,
      }),
    ).to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "MalformedPubkeysArray");

    await expect(
      maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, [invalidPubkeyHexString], receiver.address, {
        value: fee,
      }),
    ).to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "MalformedTargetPubkey");
  });

  it("Should revert if last pubkey not 48 bytes", async function () {
    const validPubey =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";
    const invalidPubkey = "1234";
    const sourcePubkeys = [`0x${validPubey}${invalidPubkey}`];
    const { targetPubkeys } = generateConsolidationRequestPayload(1);

    const fee = await getFee();

    await expect(
      maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
        value: fee,
      }),
    ).to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "MalformedPubkeysArray");
  });

  it("Should revert if addition fails at the consolidation request contract", async function () {
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount } = generateConsolidationRequestPayload(1);

    const fee = (await getFee()) * BigInt(totalSourcePubkeysCount);

    // Set mock to fail on add
    await consolidationRequestPredeployed.mock__setFailOnAddRequest(true);

    await expect(
      maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
        value: fee,
      }),
    ).to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "ConsolidationRequestAdditionFailed");
  });

  it("Should revert when balance is less than total consolidation fee", async function () {
    const keysCount = 2;
    const fee = 10n;
    const balance = 19n;

    const { sourcePubkeys, targetPubkeys } = generateConsolidationRequestPayload(keysCount);

    await consolidationRequestPredeployed.mock__setFee(fee);
    await setBalance(await maxEffectiveBalanceIncreaser.getAddress(), balance);

    await expect(
      maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
        value: fee,
      }),
    ).to.be.revertedWithCustomError(maxEffectiveBalanceIncreaser, "InsufficientValidatorConsolidationFee");
  });

  it("Should accept consolidation requests when the provided fee matches the exact required amount", async function () {
    const requestCount = 1;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount } = generateConsolidationRequestPayload(requestCount);

    const fee = 3n;
    await consolidationRequestPredeployed.mock__setFee(fee);

    await testEIP7251Mock(
      () =>
        maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
          value: fee * BigInt(totalSourcePubkeysCount),
        }),
      await maxEffectiveBalanceIncreaser.getAddress(),
      sourcePubkeys,
      targetPubkeys,
      fee,
    );

    // Check extremely high fee
    const highFee = ethers.parseEther("10");
    await consolidationRequestPredeployed.mock__setFee(highFee);

    await testEIP7251Mock(
      () =>
        maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
          value: highFee * BigInt(totalSourcePubkeysCount),
        }),
      await maxEffectiveBalanceIncreaser.getAddress(),
      sourcePubkeys,
      targetPubkeys,
      highFee,
    );
  });

  it("Should accept consolidation requests when the provided fee exceeds the required amount", async function () {
    const requestCount = 1;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount } = generateConsolidationRequestPayload(requestCount);

    await consolidationRequestPredeployed.mock__setFee(3n);
    const excessFee = 4n;

    await testEIP7251Mock(
      () =>
        maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
          value: excessFee * BigInt(totalSourcePubkeysCount),
        }),
      await maxEffectiveBalanceIncreaser.getAddress(),
      sourcePubkeys,
      targetPubkeys,
      3n,
    );

    // Check when the provided fee extremely exceeds the required amount
    const extremelyHighFee = ethers.parseEther("10");
    await setBalance(
      await maxEffectiveBalanceIncreaser.getAddress(),
      extremelyHighFee * BigInt(totalSourcePubkeysCount),
    );

    await testEIP7251Mock(
      () =>
        maxEffectiveBalanceIncreaser
          .connect(actor)
          .addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
            value: extremelyHighFee * BigInt(totalSourcePubkeysCount),
          }),
      await maxEffectiveBalanceIncreaser.getAddress(),
      sourcePubkeys,
      targetPubkeys,
      3n,
    );
  });

  it("Should correctly deduct the exact fee amount from the contract balance", async function () {
    const requestCount = 3;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount } = generateConsolidationRequestPayload(requestCount);

    const fee = 4n;
    await consolidationRequestPredeployed.mock__setFee(fee);

    const expectedTotalConsolidationFee = fee * BigInt(totalSourcePubkeysCount);
    const initialBalance = await ethers.provider.getBalance(actor.address);
    const tx = await maxEffectiveBalanceIncreaser.addConsolidationRequests(
      sourcePubkeys,
      targetPubkeys,
      receiver.address,
      { value: expectedTotalConsolidationFee },
    );
    const receipt = await tx.wait();

    if (!receipt) {
      expect(false).to.equal(true);
    }

    const gasUsed = receipt!.gasUsed;
    const gasPrice = receipt!.gasPrice;
    const totalCost = BigInt(gasUsed) * gasPrice + expectedTotalConsolidationFee;

    expect(await ethers.provider.getBalance(actor.address)).to.equal(initialBalance - totalCost);
  });

  it("Should transfer the total calculated fee to the EIP-7251 consolidation request contract", async function () {
    const requestCount = 3;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount } = generateConsolidationRequestPayload(requestCount);

    const fee = 3n;
    await consolidationRequestPredeployed.mock__setFee(fee);
    const expectedTotalConsolidationFee = fee * BigInt(totalSourcePubkeysCount);
    const initialBalance = await getConsolidationRequestPredeployedContractBalance();
    await maxEffectiveBalanceIncreaser.addConsolidationRequests(sourcePubkeys, targetPubkeys, receiver.address, {
      value: expectedTotalConsolidationFee,
    });
    expect(await getConsolidationRequestPredeployedContractBalance()).to.equal(
      initialBalance + expectedTotalConsolidationFee,
    );
  });

  it("Should ensure consolidation requests are encoded as expected with two 48-byte pubkeys", async function () {
    const requestCount = 16;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount } = generateConsolidationRequestPayload(requestCount);

    const fee = 3n;
    await consolidationRequestPredeployed.mock__setFee(fee);
    const expectedTotalConsolidationFee = fee * BigInt(totalSourcePubkeysCount);

    const tx = await maxEffectiveBalanceIncreaser.addConsolidationRequests(
      sourcePubkeys,
      targetPubkeys,
      receiver.address,
      { value: expectedTotalConsolidationFee },
    );
    const receipt = await tx.wait();

    const events = findEIP7251MockEvents(receipt!);
    expect(events.length).to.equal(totalSourcePubkeysCount);

    for (let i = 0; i < requestCount; i++) {
      const pubkeysCount = Math.floor(sourcePubkeys[i].length / KEY_LENGTH);
      for (let j = 0; j < pubkeysCount; j++) {
        const expectedSourcePubkey = sourcePubkeys[i].slice(j * KEY_LENGTH, (j + 1) * KEY_LENGTH);
        const encodedRequest = events[i * pubkeysCount + j].args[0];

        expect(encodedRequest.length).to.equal(2 + KEY_LENGTH * 2 + KEY_LENGTH * 2);

        expect(encodedRequest.slice(0, 2)).to.equal("0x");
        const sourcePubkeyFromEvent = "0x" + encodedRequest.slice(2, KEY_LENGTH * 2 + 2);
        expect(sourcePubkeyFromEvent).to.equal(ethers.hexlify(expectedSourcePubkey));

        const targetPubkeyFromEvent = "0x" + encodedRequest.slice(KEY_LENGTH * 2 + 2, KEY_LENGTH * 4 + 2);
        expect(targetPubkeyFromEvent).to.equal(ethers.hexlify(targetPubkeys[i]));
      }
    }
  });
});
