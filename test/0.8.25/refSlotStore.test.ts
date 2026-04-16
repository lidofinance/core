import { expect } from "chai";
import { keccak256, toUtf8Bytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__MockForRedeemsBuffer, RefSlotStore } from "typechain-types";

import { Snapshot } from "test/suite";

describe("RefSlotStore.sol", () => {
  let admin: HardhatEthersSigner;
  let writer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let consensus: HashConsensus__MockForRedeemsBuffer;
  let store: RefSlotStore;

  const DEFAULT_REF_SLOT = 100n;
  const SLOT_A = keccak256(toUtf8Bytes("slot.A"));
  const SLOT_B = keccak256(toUtf8Bytes("slot.B"));

  let originalState: string;

  before(async () => {
    [, admin, writer, stranger] = await ethers.getSigners();

    consensus = await ethers.deployContract("HashConsensus__MockForRedeemsBuffer", [DEFAULT_REF_SLOT]);
    store = await ethers.deployContract("RefSlotStore", [await consensus.getAddress(), admin.address]);

    // Grant WRITER_ROLE to writer
    const WRITER_ROLE = await store.WRITER_ROLE();
    await store.connect(admin).grantRole(WRITER_ROLE, writer.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("set / getValue", () => {
    it("basic set and read", async () => {
      await store.connect(writer).set(SLOT_A, 42);
      expect(await store.getValue(SLOT_A)).to.equal(42);
    });

    it("overwrites previous value", async () => {
      await store.connect(writer).set(SLOT_A, 10);
      await store.connect(writer).set(SLOT_A, 20);
      expect(await store.getValue(SLOT_A)).to.equal(20);
    });
  });

  context("getSnapshotValue", () => {
    it("returns value at last refSlot boundary", async () => {
      // At refSlot 100, set value to 50
      await store.connect(writer).set(SLOT_A, 50);

      // When refSlot has not changed, getSnapshotValue returns the valueOnRefSlot (0 in this case)
      // because cached refSlot == current refSlot
      expect(await store.getSnapshotValue(SLOT_A)).to.equal(0);

      // Advance refSlot
      await consensus.setRefSlot(200n);

      // Now getSnapshotValue should return the current value since refSlot changed
      // (cached refSlot 100 != current refSlot 200 => returns current value)
      expect(await store.getSnapshotValue(SLOT_A)).to.equal(50);
    });
  });

  context("snapshot trigger", () => {
    it("when refSlot changes, snapshot captures pre-change value", async () => {
      // At refSlot 100, set value to 100
      await store.connect(writer).set(SLOT_A, 100);

      // Advance to refSlot 200
      await consensus.setRefSlot(200n);

      // Set new value at refSlot 200 (this triggers the snapshot internally)
      await store.connect(writer).set(SLOT_A, 250);

      // getSnapshotValue should return the value at refSlot boundary (100, the pre-change value)
      expect(await store.getSnapshotValue(SLOT_A)).to.equal(100);

      // getValue returns the current live value
      expect(await store.getValue(SLOT_A)).to.equal(250);
    });

    it("multiple sets within same refSlot do not re-snapshot", async () => {
      // At refSlot 100, set multiple values
      await store.connect(writer).set(SLOT_A, 10);
      await store.connect(writer).set(SLOT_A, 20);
      await store.connect(writer).set(SLOT_A, 30);

      // Advance refSlot
      await consensus.setRefSlot(200n);

      // snapshot should capture the final value from refSlot 100
      expect(await store.getSnapshotValue(SLOT_A)).to.equal(30);

      // Set at refSlot 200, this triggers snapshot of 30
      await store.connect(writer).set(SLOT_A, 99);
      expect(await store.getSnapshotValue(SLOT_A)).to.equal(30);
      expect(await store.getValue(SLOT_A)).to.equal(99);
    });
  });

  context("reset", () => {
    it("zeroes everything", async () => {
      await store.connect(writer).set(SLOT_A, 42);
      expect(await store.getValue(SLOT_A)).to.equal(42);

      await store.connect(writer).reset(SLOT_A);
      expect(await store.getValue(SLOT_A)).to.equal(0);
      expect(await store.getSnapshotValue(SLOT_A)).to.equal(0);
    });

    it("reverts when caller lacks WRITER_ROLE", async () => {
      const WRITER_ROLE = await store.WRITER_ROLE();
      await expect(store.connect(stranger).reset(SLOT_A))
        .to.be.revertedWithCustomError(store, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, WRITER_ROLE);
    });
  });

  context("WRITER_ROLE", () => {
    it("reverts when caller lacks role for set", async () => {
      const WRITER_ROLE = await store.WRITER_ROLE();
      await expect(store.connect(stranger).set(SLOT_A, 1))
        .to.be.revertedWithCustomError(store, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, WRITER_ROLE);
    });

    it("allows granted writer to set", async () => {
      await store.connect(writer).set(SLOT_A, 123);
      expect(await store.getValue(SLOT_A)).to.equal(123);
    });
  });

  context("events", () => {
    it("set emits ValueSet with live value, snapshot, and current refSlot on first write", async () => {
      await expect(store.connect(writer).set(SLOT_A, 42))
        .to.emit(store, "ValueSet")
        .withArgs(SLOT_A, 42, 0, DEFAULT_REF_SLOT);
    });

    it("set in same refSlot emits ValueSet with preserved valueOnRefSlot", async () => {
      await store.connect(writer).set(SLOT_A, 10);
      await expect(store.connect(writer).set(SLOT_A, 20))
        .to.emit(store, "ValueSet")
        .withArgs(SLOT_A, 20, 0, DEFAULT_REF_SLOT);
    });

    it("set after refSlot advance emits ValueSet capturing pre-advance value into valueOnRefSlot", async () => {
      await store.connect(writer).set(SLOT_A, 77);
      await consensus.setRefSlot(200n);
      await expect(store.connect(writer).set(SLOT_A, 99)).to.emit(store, "ValueSet").withArgs(SLOT_A, 99, 77, 200n);
    });

    it("reset emits ValueReset", async () => {
      await store.connect(writer).set(SLOT_A, 42);
      await expect(store.connect(writer).reset(SLOT_A)).to.emit(store, "ValueReset").withArgs(SLOT_A);
    });
  });

  context("multiple slots", () => {
    it("different bytes32 keys do not interfere", async () => {
      await store.connect(writer).set(SLOT_A, 100);
      await store.connect(writer).set(SLOT_B, 200);

      expect(await store.getValue(SLOT_A)).to.equal(100);
      expect(await store.getValue(SLOT_B)).to.equal(200);

      // Modify SLOT_A, SLOT_B should remain unchanged
      await store.connect(writer).set(SLOT_A, 300);
      expect(await store.getValue(SLOT_A)).to.equal(300);
      expect(await store.getValue(SLOT_B)).to.equal(200);

      // Reset SLOT_A, SLOT_B unaffected
      await store.connect(writer).reset(SLOT_A);
      expect(await store.getValue(SLOT_A)).to.equal(0);
      expect(await store.getValue(SLOT_B)).to.equal(200);
    });

    it("snapshot isolation across slots", async () => {
      // Set both at refSlot 100
      await store.connect(writer).set(SLOT_A, 10);
      await store.connect(writer).set(SLOT_B, 20);

      // Advance refSlot
      await consensus.setRefSlot(200n);

      // Set new values
      await store.connect(writer).set(SLOT_A, 50);
      await store.connect(writer).set(SLOT_B, 60);

      // Snapshots should be independent
      expect(await store.getSnapshotValue(SLOT_A)).to.equal(10);
      expect(await store.getSnapshotValue(SLOT_B)).to.equal(20);

      expect(await store.getValue(SLOT_A)).to.equal(50);
      expect(await store.getValue(SLOT_B)).to.equal(60);
    });
  });
});
