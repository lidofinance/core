import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsBus } from "typechain-types";

import { proxify } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import {
  fullWithdrawal,
  MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI,
  partialWithdrawal,
  pubkeyAt,
  toIntents,
} from "../triggerable-withdrawals-helpers";

describe("TriggerableWithdrawalsBus.sol: addWithdrawalIntents", () => {
  let bus: TriggerableWithdrawalsBus;
  let admin: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [admin, publisher, stranger] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    const impl = await ethers.deployContract("TriggerableWithdrawalsBus", [await locator.getAddress()]);
    [bus] = await proxify({ impl, admin });
    await bus.initialize(admin.address);

    await bus.connect(admin).grantRole(await bus.ADD_WITHDRAWAL_INTENTS_ROLE(), publisher.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("access control", () => {
    it("reverts if caller has no ADD_WITHDRAWAL_INTENTS_ROLE", async () => {
      await expect(bus.connect(stranger).addWithdrawalIntents([fullWithdrawal(0)]))
        .to.be.revertedWithCustomError(bus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await bus.ADD_WITHDRAWAL_INTENTS_ROLE());
    });

    it("reverts for the admin without the role", async () => {
      await expect(bus.connect(admin).addWithdrawalIntents([fullWithdrawal(0)]))
        .to.be.revertedWithCustomError(bus, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, await bus.ADD_WITHDRAWAL_INTENTS_ROLE());
    });
  });

  context("validation", () => {
    it("reverts on an empty array", async () => {
      await expect(bus.connect(publisher).addWithdrawalIntents([]))
        .to.be.revertedWithCustomError(bus, "ZeroArgument")
        .withArgs("intents");
    });

    for (const length of [0, 47, 49, 96]) {
      it(`reverts on a ${length}-byte pubkey and reports its index`, async () => {
        const invalid = { amount: 0n, pubkey: ethers.hexlify(ethers.randomBytes(length)) };

        await expect(bus.connect(publisher).addWithdrawalIntents([fullWithdrawal(0), fullWithdrawal(1), invalid]))
          .to.be.revertedWithCustomError(bus, "InvalidPubkeyLength")
          .withArgs(2, length);
      });
    }

    it("reverts on a partial withdrawal above the max amount and reports its index", async () => {
      const tooLarge = MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI + 1n;

      await expect(bus.connect(publisher).addWithdrawalIntents([partialWithdrawal(0, tooLarge), fullWithdrawal(1)]))
        .to.be.revertedWithCustomError(bus, "WithdrawalAmountTooLarge")
        .withArgs(0, tooLarge);
    });

    it("reverts on the max uint64 amount", async () => {
      const maxUint64 = 2n ** 64n - 1n;

      await expect(bus.connect(publisher).addWithdrawalIntents([partialWithdrawal(0, maxUint64)]))
        .to.be.revertedWithCustomError(bus, "WithdrawalAmountTooLarge")
        .withArgs(0, maxUint64);
    });

    it("does not store anything if any intent in the batch is invalid", async () => {
      const invalid = { amount: 0n, pubkey: "0x1234" };

      await expect(
        bus.connect(publisher).addWithdrawalIntents([fullWithdrawal(0), invalid]),
      ).to.be.revertedWithCustomError(bus, "InvalidPubkeyLength");

      expect(await bus.unprocessedIntentsCount()).to.equal(0);
    });
  });

  context("happy path", () => {
    it("appends full and partial withdrawal intents in order", async () => {
      const intents = [
        fullWithdrawal(0),
        partialWithdrawal(1, 1n),
        partialWithdrawal(2, 32n * 10n ** 9n),
        partialWithdrawal(3, MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI),
      ];

      await expect(bus.connect(publisher).addWithdrawalIntents(intents))
        .to.emit(bus, "WithdrawalIntentsAdded")
        .withArgs(0, intents.length);

      expect(await bus.unprocessedIntentsCount()).to.equal(intents.length);
      expect(toIntents(await bus.getWithdrawalIntents(0, intents.length))).to.deep.equal(intents);
    });

    it("preserves pubkey bytes at the head/tail packing boundary", async () => {
      const pubkey = ethers.concat([ethers.ZeroHash, "0x" + "ff".repeat(16)]);
      const edgeIntents = [
        { amount: 0n, pubkey },
        { amount: MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI, pubkey: "0x" + "ff".repeat(48) },
        { amount: 1n, pubkey: "0x" + "00".repeat(48) },
      ];

      await bus.connect(publisher).addWithdrawalIntents(edgeIntents);

      expect(toIntents(await bus.getWithdrawalIntents(0, edgeIntents.length))).to.deep.equal(edgeIntents);
    });

    it("continues queue indices across calls", async () => {
      await expect(bus.connect(publisher).addWithdrawalIntents([fullWithdrawal(0), fullWithdrawal(1)]))
        .to.emit(bus, "WithdrawalIntentsAdded")
        .withArgs(0, 2);

      await expect(bus.connect(publisher).addWithdrawalIntents([partialWithdrawal(2, 5n)]))
        .to.emit(bus, "WithdrawalIntentsAdded")
        .withArgs(2, 1);

      expect(await bus.unprocessedIntentsCount()).to.equal(3);
      expect(toIntents(await bus.getWithdrawalIntents(0, 3))).to.deep.equal([
        fullWithdrawal(0),
        fullWithdrawal(1),
        partialWithdrawal(2, 5n),
      ]);
    });

    it("accepts duplicate intents for the same validator", async () => {
      const intents = [partialWithdrawal(0, 1n), partialWithdrawal(0, 1n), fullWithdrawal(0)];

      await bus.connect(publisher).addWithdrawalIntents(intents);

      expect(toIntents(await bus.getWithdrawalIntents(0, intents.length))).to.deep.equal(intents);
    });

    it("stores each intent in two storage slots", async () => {
      const intent = partialWithdrawal(0, 0x1234567890n);

      await bus.connect(publisher).addWithdrawalIntents([intent]);

      // ERC-7201 slot of the bus storage struct: head/tail at +0, intents mapping at +1
      const storageBase = BigInt("0x9e1225a4f3b25c5ccb4127158e802e544055b00f6ae9908793cdfb52b5dd5100");
      const mappingSlot = ethers.toBeHex(storageBase + 1n, 32);
      const entrySlot = BigInt(ethers.keccak256(ethers.concat([ethers.toBeHex(0, 32), mappingSlot])));

      const busAddress = await bus.getAddress();
      const word0 = await ethers.provider.getStorage(busAddress, entrySlot);
      const word1 = await ethers.provider.getStorage(busAddress, entrySlot + 1n);

      expect(word0).to.equal(ethers.dataSlice(pubkeyAt(0), 0, 32));
      expect(word1).to.equal(ethers.concat([ethers.dataSlice(pubkeyAt(0), 32, 48), ethers.toBeHex(intent.amount, 16)]));
    });
  });
});
