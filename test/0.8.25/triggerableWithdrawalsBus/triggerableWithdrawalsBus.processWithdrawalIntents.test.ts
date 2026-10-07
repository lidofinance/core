import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LidoLocator,
  RefundRecipient__MockForTriggerableWithdrawalsBus,
  TriggerableWithdrawalsBus,
  TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus,
} from "typechain-types";

import { proxify } from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

import {
  fullWithdrawal,
  MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI,
  partialWithdrawal,
  toIntents,
  WithdrawalIntent,
} from "../triggerable-withdrawals-helpers";

describe("TriggerableWithdrawalsBus.sol: processWithdrawalIntents", () => {
  let bus: TriggerableWithdrawalsBus;
  let gateway: TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus;
  let locator: LidoLocator;
  let admin: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let refundRecipient: HardhatEthersSigner;

  const QUEUED: WithdrawalIntent[] = [
    fullWithdrawal(0),
    partialWithdrawal(1, 1n),
    partialWithdrawal(2, 32n * 10n ** 9n),
    fullWithdrawal(3),
    partialWithdrawal(4, MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI),
  ];

  let originalState: string;

  before(async () => {
    [admin, publisher, executor, refundRecipient] = await ethers.getSigners();

    gateway = await ethers.deployContract("TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus");
    locator = await deployLidoLocator({ triggerableWithdrawalsGateway: await gateway.getAddress() });

    const impl = await ethers.deployContract("TriggerableWithdrawalsBus", [await locator.getAddress()]);
    [bus] = await proxify({ impl, admin });
    await bus.initialize(admin.address);

    await bus.connect(admin).grantRole(await bus.ADD_WITHDRAWAL_INTENTS_ROLE(), publisher.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  const addQueued = () => bus.connect(publisher).addWithdrawalIntents(QUEUED);

  const expectForwarded = async (tx: Promise<unknown>, intents: WithdrawalIntent[]) => {
    for (const intent of intents) {
      await expect(tx).to.emit(gateway, "Mock__WithdrawalIntent").withArgs(intent.pubkey, intent.amount);
    }
  };

  context("validation", () => {
    it("reverts if count is zero", async () => {
      await addQueued();

      await expect(bus.connect(executor).processWithdrawalIntents(0, executor.address, { value: 10n }))
        .to.be.revertedWithCustomError(bus, "ZeroArgument")
        .withArgs("count");
    });

    it("reverts if the queue is empty", async () => {
      await expect(
        bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: 10n }),
      ).to.be.revertedWithCustomError(bus, "NoWithdrawalIntents");
    });

    it("reverts once all intents are processed", async () => {
      await addQueued();
      await bus.connect(executor).processWithdrawalIntents(QUEUED.length, executor.address, { value: 10n });

      await expect(
        bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: 10n }),
      ).to.be.revertedWithCustomError(bus, "NoWithdrawalIntents");
    });
  });

  context("processing", () => {
    beforeEach(addQueued);

    it("processes intents from the head of the queue in order", async () => {
      const tx = bus.connect(executor).processWithdrawalIntents(3, refundRecipient.address, { value: 10n });

      await expect(tx).to.emit(bus, "WithdrawalIntentsProcessed").withArgs(0, 3);
      await expect(tx)
        .to.emit(gateway, "Mock__TriggerWithdrawalsCalled")
        .withArgs(await bus.getAddress(), 3, refundRecipient.address, 10n);
      await expectForwarded(tx, QUEUED.slice(0, 3));

      expect(await bus.unprocessedIntentsCount()).to.equal(QUEUED.length - 3);
      expect(toIntents(await bus.getWithdrawalIntents(0, QUEUED.length))).to.deep.equal(QUEUED.slice(3));
    });

    it("continues from the new head on the next call", async () => {
      await bus.connect(executor).processWithdrawalIntents(2, executor.address, { value: 10n });

      const tx = bus.connect(executor).processWithdrawalIntents(2, executor.address, { value: 10n });

      await expect(tx).to.emit(bus, "WithdrawalIntentsProcessed").withArgs(2, 2);
      await expectForwarded(tx, QUEUED.slice(2, 4));
      expect(toIntents(await bus.getWithdrawalIntents(0, QUEUED.length))).to.deep.equal(QUEUED.slice(4));
    });

    it("processes only the queued intents if count exceeds the queue length", async () => {
      const count = QUEUED.length + 10;

      expect(
        await bus.connect(executor).processWithdrawalIntents.staticCall(count, executor.address, { value: 10n }),
      ).to.equal(QUEUED.length);

      const tx = bus.connect(executor).processWithdrawalIntents(count, executor.address, { value: 10n });

      await expect(tx).to.emit(bus, "WithdrawalIntentsProcessed").withArgs(0, QUEUED.length);
      await expectForwarded(tx, QUEUED);
      expect(await bus.unprocessedIntentsCount()).to.equal(0);
      expect(await bus.getWithdrawalIntents(0, 10)).to.deep.equal([]);
    });

    it("returns the processed count", async () => {
      expect(
        await bus.connect(executor).processWithdrawalIntents.staticCall(2, executor.address, { value: 10n }),
      ).to.equal(2);
    });

    it("keeps queue indices growing after the queue is drained and refilled", async () => {
      await bus.connect(executor).processWithdrawalIntents(QUEUED.length, executor.address, { value: 10n });

      await expect(bus.connect(publisher).addWithdrawalIntents([fullWithdrawal(7)]))
        .to.emit(bus, "WithdrawalIntentsAdded")
        .withArgs(QUEUED.length, 1);

      const tx = bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: 10n });
      await expect(tx).to.emit(bus, "WithdrawalIntentsProcessed").withArgs(QUEUED.length, 1);
      await expectForwarded(tx, [fullWithdrawal(7)]);
    });

    it("is permissionless", async () => {
      const [, , , , stranger] = await ethers.getSigners();

      await expect(bus.connect(stranger).processWithdrawalIntents(1, stranger.address, { value: 10n }))
        .to.emit(bus, "WithdrawalIntentsProcessed")
        .withArgs(0, 1);
    });

    it("clears storage of processed intents", async () => {
      const storageBase = BigInt("0x9e1225a4f3b25c5ccb4127158e802e544055b00f6ae9908793cdfb52b5dd5100");
      const mappingSlot = ethers.toBeHex(storageBase + 1n, 32);
      const entrySlot = BigInt(ethers.keccak256(ethers.concat([ethers.toBeHex(0, 32), mappingSlot])));
      const busAddress = await bus.getAddress();

      expect(await ethers.provider.getStorage(busAddress, entrySlot)).to.not.equal(ethers.ZeroHash);

      await bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: 10n });

      expect(await ethers.provider.getStorage(busAddress, entrySlot)).to.equal(ethers.ZeroHash);
      expect(await ethers.provider.getStorage(busAddress, entrySlot + 1n)).to.equal(ethers.ZeroHash);
    });
  });

  context("fee and refund", () => {
    beforeEach(addQueued);

    it("forwards msg.value to the gateway", async () => {
      const value = ethers.parseEther("1");

      await expect(bus.connect(executor).processWithdrawalIntents(2, refundRecipient.address, { value }))
        .to.emit(gateway, "Mock__TriggerWithdrawalsCalled")
        .withArgs(await bus.getAddress(), 2, refundRecipient.address, value);
    });

    it("passes the refund recipient and the gateway refunds it", async () => {
      await gateway.mock__setFeePerRequest(3n);

      await expect(
        bus.connect(executor).processWithdrawalIntents(2, refundRecipient.address, { value: 10n }),
      ).to.changeEtherBalances([executor, refundRecipient, gateway, bus], [-10n, 4n, 6n, 0n]);
    });

    it("refunds to the caller if the refund recipient is zero address", async () => {
      await gateway.mock__setFeePerRequest(3n);

      const tx = bus.connect(executor).processWithdrawalIntents(2, ethers.ZeroAddress, { value: 10n });

      await expect(tx)
        .to.emit(gateway, "Mock__TriggerWithdrawalsCalled")
        .withArgs(await bus.getAddress(), 2, executor.address, 10n);
      await expect(tx).to.changeEtherBalances([executor, gateway, bus], [-6n, 6n, 0n]);
    });

    it("cannot receive ETH directly", async () => {
      await expect(executor.sendTransaction({ to: await bus.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  context("gateway failures", () => {
    beforeEach(addQueued);

    it("leaves the queue unchanged if the gateway reverts", async () => {
      await gateway.mock__setRevert(true);

      await expect(
        bus.connect(executor).processWithdrawalIntents(3, executor.address, { value: 10n }),
      ).to.be.revertedWithCustomError(gateway, "Mock__TriggerWithdrawalsReverted");

      expect(await bus.unprocessedIntentsCount()).to.equal(QUEUED.length);
      expect(toIntents(await bus.getWithdrawalIntents(0, QUEUED.length))).to.deep.equal(QUEUED);
    });

    it("resolves the gateway via the locator at call time", async () => {
      const newGateway = await ethers.deployContract("TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus");
      await updateLidoLocatorImplementation(await locator.getAddress(), {
        triggerableWithdrawalsGateway: await newGateway.getAddress(),
      });

      const tx = bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: 10n });

      await expect(tx).to.emit(newGateway, "Mock__TriggerWithdrawalsCalled");
      await expect(tx).to.not.emit(gateway, "Mock__TriggerWithdrawalsCalled");
    });
  });

  context("reentrancy", () => {
    let reentrantRecipient: RefundRecipient__MockForTriggerableWithdrawalsBus;

    beforeEach(async () => {
      await addQueued();
      reentrantRecipient = await ethers.deployContract("RefundRecipient__MockForTriggerableWithdrawalsBus", [
        await bus.getAddress(),
      ]);
    });

    it("processes the next intents when the refund recipient re-enters", async () => {
      await reentrantRecipient.mock__setReentries(1n);

      const tx = bus
        .connect(executor)
        .processWithdrawalIntents(2, await reentrantRecipient.getAddress(), { value: 10n });

      await expect(tx).to.emit(bus, "WithdrawalIntentsProcessed").withArgs(0, 2);
      await expect(tx).to.emit(bus, "WithdrawalIntentsProcessed").withArgs(2, 1);
      await expect(tx).to.emit(reentrantRecipient, "Mock__RefundReceived").withArgs(8n);
      await expectForwarded(tx, QUEUED.slice(0, 3));

      expect(await bus.unprocessedIntentsCount()).to.equal(QUEUED.length - 3);
      expect(toIntents(await bus.getWithdrawalIntents(0, QUEUED.length))).to.deep.equal(QUEUED.slice(3));
    });
  });
});
