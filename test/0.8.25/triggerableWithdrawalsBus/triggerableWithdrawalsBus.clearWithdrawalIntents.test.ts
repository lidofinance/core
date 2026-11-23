import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  TriggerableWithdrawalsBus,
  TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus,
} from "typechain-types";

import { proxify } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import { fullWithdrawal, partialWithdrawal, toIntents, WithdrawalIntent } from "../triggerable-withdrawals-helpers";

describe("TriggerableWithdrawalsBus.sol: clearWithdrawalIntents", () => {
  let bus: TriggerableWithdrawalsBus;
  let gateway: TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus;
  let admin: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let clearer: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const QUEUED: WithdrawalIntent[] = [
    fullWithdrawal(0),
    partialWithdrawal(1, 1n),
    fullWithdrawal(2),
    partialWithdrawal(3, 3n),
  ];

  let originalState: string;

  before(async () => {
    [admin, publisher, clearer, executor, stranger] = await ethers.getSigners();

    gateway = await ethers.deployContract("TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus");
    const locator = await deployLidoLocator({ triggerableWithdrawalsGateway: await gateway.getAddress() });

    const impl = await ethers.deployContract("TriggerableWithdrawalsBus", [await locator.getAddress()]);
    [bus] = await proxify({ impl, admin });
    await bus.initialize(admin.address);

    await bus.connect(admin).grantRole(await bus.ADD_WITHDRAWAL_INTENTS_ROLE(), publisher.address);
    await bus.connect(admin).grantRole(await bus.CLEAR_WITHDRAWAL_INTENTS_ROLE(), clearer.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  const addQueued = () => bus.connect(publisher).addWithdrawalIntents(QUEUED);

  context("access control", () => {
    it("reverts if caller has no CLEAR_WITHDRAWAL_INTENTS_ROLE", async () => {
      await expect(bus.connect(stranger).clearWithdrawalIntents())
        .to.be.revertedWithCustomError(bus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await bus.CLEAR_WITHDRAWAL_INTENTS_ROLE());
    });

    it("reverts for the admin without the role", async () => {
      await expect(bus.connect(admin).clearWithdrawalIntents())
        .to.be.revertedWithCustomError(bus, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, await bus.CLEAR_WITHDRAWAL_INTENTS_ROLE());
    });

    it("reverts for the publisher without the role", async () => {
      await expect(bus.connect(publisher).clearWithdrawalIntents())
        .to.be.revertedWithCustomError(bus, "AccessControlUnauthorizedAccount")
        .withArgs(publisher.address, await bus.CLEAR_WITHDRAWAL_INTENTS_ROLE());
    });
  });

  context("clearing", () => {
    it("drops all unprocessed intents", async () => {
      await addQueued();

      await expect(bus.connect(clearer).clearWithdrawalIntents())
        .to.emit(bus, "WithdrawalIntentsCleared")
        .withArgs(QUEUED.length);

      expect(await bus.unprocessedIntentsCount()).to.equal(0);
      expect(await bus.getWithdrawalIntents(0, QUEUED.length)).to.deep.equal([]);
    });

    it("drops only the intents left after partial processing", async () => {
      await addQueued();
      await bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: 10n });

      await expect(bus.connect(clearer).clearWithdrawalIntents())
        .to.emit(bus, "WithdrawalIntentsCleared")
        .withArgs(QUEUED.length - 1);

      expect(await bus.unprocessedIntentsCount()).to.equal(0);
    });

    it("does not revert on an empty queue", async () => {
      await expect(bus.connect(clearer).clearWithdrawalIntents()).to.emit(bus, "WithdrawalIntentsCleared").withArgs(0);

      await addQueued();
      await bus.connect(executor).processWithdrawalIntents(QUEUED.length, executor.address, { value: 10n });

      await expect(bus.connect(clearer).clearWithdrawalIntents()).to.emit(bus, "WithdrawalIntentsCleared").withArgs(0);
    });

    it("sends nothing to the gateway", async () => {
      await addQueued();

      const tx = bus.connect(clearer).clearWithdrawalIntents();

      await expect(tx).to.not.emit(gateway, "Mock__TriggerWithdrawalsCalled");
      expect((await (await tx).wait())!.logs.map((log) => log.address)).to.deep.equal([await bus.getAddress()]);
    });

    it("leaves nothing to process", async () => {
      await addQueued();
      await bus.connect(clearer).clearWithdrawalIntents();

      await expect(bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: 10n }))
        .to.be.revertedWithCustomError(bus, "InsufficientWithdrawalIntents")
        .withArgs(1, 0);
    });
  });

  context("after clearing", () => {
    const NEW: WithdrawalIntent[] = [partialWithdrawal(10, 10n), fullWithdrawal(11)];

    beforeEach(async () => {
      await addQueued();
      await bus.connect(clearer).clearWithdrawalIntents();
    });

    it("restarts queue indices from zero for new intents and hides the dropped ones", async () => {
      await expect(bus.connect(publisher).addWithdrawalIntents(NEW))
        .to.emit(bus, "WithdrawalIntentsAdded")
        .withArgs(0, NEW.length);

      // NEW is shorter than QUEUED: dropped intents still in storage past the new tail stay invisible
      expect(await bus.unprocessedIntentsCount()).to.equal(NEW.length);
      expect(toIntents(await bus.getWithdrawalIntents(0, 10))).to.deep.equal(NEW);
    });

    it("processes only the new intents", async () => {
      await bus.connect(publisher).addWithdrawalIntents(NEW);

      const tx = bus.connect(executor).processWithdrawalIntents(NEW.length, executor.address, { value: 10n });

      await expect(tx).to.emit(bus, "WithdrawalIntentsProcessed").withArgs(0, NEW.length);

      const gatewayAddress = await gateway.getAddress();
      const forwarded = (await (await tx).wait())!.logs
        .filter((log) => log.address === gatewayAddress)
        .map((log) => gateway.interface.parseLog(log))
        .filter((parsed) => parsed?.name === "Mock__WithdrawalIntent")
        .map((parsed) => ({ amount: parsed!.args.amount, pubkey: parsed!.args.pubkey }));
      expect(forwarded).to.deep.equal(NEW);
    });
  });
});
