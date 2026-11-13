import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsBus } from "typechain-types";

import { proxify } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import { fullWithdrawal, partialWithdrawal, toIntents, WithdrawalIntent } from "../triggerable-withdrawals-helpers";

describe("TriggerableWithdrawalsBus.sol: views", () => {
  let bus: TriggerableWithdrawalsBus;
  let admin: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let executor: HardhatEthersSigner;

  const QUEUED: WithdrawalIntent[] = [
    fullWithdrawal(0),
    partialWithdrawal(1, 1n),
    partialWithdrawal(2, 2n),
    fullWithdrawal(3),
    partialWithdrawal(4, 4n),
    partialWithdrawal(5, 5n),
  ];

  let originalState: string;

  before(async () => {
    [admin, publisher, executor] = await ethers.getSigners();

    const gateway = await ethers.deployContract("TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus");
    const locator = await deployLidoLocator({ triggerableWithdrawalsGateway: await gateway.getAddress() });

    const impl = await ethers.deployContract("TriggerableWithdrawalsBus", [await locator.getAddress()]);
    [bus] = await proxify({ impl, admin });
    await bus.initialize(admin.address);

    await bus.connect(admin).grantRole(await bus.ADD_WITHDRAWAL_INTENTS_ROLE(), publisher.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("unprocessedIntentsCount", () => {
    it("tracks additions and processing", async () => {
      expect(await bus.unprocessedIntentsCount()).to.equal(0);

      await bus.connect(publisher).addWithdrawalIntents(QUEUED.slice(0, 4));
      expect(await bus.unprocessedIntentsCount()).to.equal(4);

      await bus.connect(publisher).addWithdrawalIntents(QUEUED.slice(4));
      expect(await bus.unprocessedIntentsCount()).to.equal(QUEUED.length);

      await bus.connect(executor).processWithdrawalIntents(3, executor.address, { value: 10n });
      expect(await bus.unprocessedIntentsCount()).to.equal(QUEUED.length - 3);
    });
  });

  context("getWithdrawalIntents", () => {
    beforeEach(async () => {
      await bus.connect(publisher).addWithdrawalIntents(QUEUED);
    });

    it("returns the whole queue", async () => {
      expect(toIntents(await bus.getWithdrawalIntents(0, QUEUED.length))).to.deep.equal(QUEUED);
    });

    it("returns a page from the given offset", async () => {
      expect(toIntents(await bus.getWithdrawalIntents(2, 3))).to.deep.equal(QUEUED.slice(2, 5));
    });

    it("truncates the page at the end of the queue", async () => {
      expect(toIntents(await bus.getWithdrawalIntents(4, 100))).to.deep.equal(QUEUED.slice(4));
    });

    it("returns the last intent", async () => {
      expect(toIntents(await bus.getWithdrawalIntents(QUEUED.length - 1, 1))).to.deep.equal(QUEUED.slice(-1));
    });

    it("returns an empty array if limit is zero", async () => {
      expect(await bus.getWithdrawalIntents(0, 0)).to.deep.equal([]);
    });

    it("returns an empty array if offset is at or beyond the end of the queue", async () => {
      expect(await bus.getWithdrawalIntents(QUEUED.length, 1)).to.deep.equal([]);
      expect(await bus.getWithdrawalIntents(QUEUED.length + 1, 1)).to.deep.equal([]);
      expect(await bus.getWithdrawalIntents(ethers.MaxUint256, ethers.MaxUint256)).to.deep.equal([]);
    });

    it("handles the max limit", async () => {
      expect(toIntents(await bus.getWithdrawalIntents(1, ethers.MaxUint256))).to.deep.equal(QUEUED.slice(1));
    });

    it("counts offset from the current head of the queue", async () => {
      await bus.connect(executor).processWithdrawalIntents(2, executor.address, { value: 10n });

      expect(toIntents(await bus.getWithdrawalIntents(0, 2))).to.deep.equal(QUEUED.slice(2, 4));
      expect(toIntents(await bus.getWithdrawalIntents(1, 100))).to.deep.equal(QUEUED.slice(3));
      expect(await bus.getWithdrawalIntents(QUEUED.length - 2, 1)).to.deep.equal([]);
    });
  });
});
