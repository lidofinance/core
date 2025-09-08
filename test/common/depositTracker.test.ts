import { expect } from "chai";
import { ethers } from "hardhat";

import { DepositsTracker, DepositsTracker__Harness, SlotDepositPacking__Harness } from "typechain-types";

describe("DepositTracker.sol", () => {
  let slotDepositPacking: SlotDepositPacking__Harness;
  let depositTracker: DepositsTracker__Harness;
  let depositTrackerLib: DepositsTracker;

  beforeEach(async () => {
    slotDepositPacking = await ethers.deployContract("SlotDepositPacking__Harness");
    depositTrackerLib = await ethers.deployContract("DepositsTracker");
    depositTracker = await ethers.deployContract("DepositsTracker__Harness", {
      libraries: {
        ["contracts/common/lib/DepositsTracker.sol:DepositsTracker"]: await depositTrackerLib.getAddress(),
      },
    });
  });

  context("SlotDepositPacking", () => {
    it("Min values", async () => {
      const packed = await slotDepositPacking.pack(0n, 0n);
      const unpacked = await slotDepositPacking.unpack(packed);
      expect(unpacked.slot).to.equal(0);
      expect(unpacked.depositedEth).to.equal(0);
    });

    it("Max values", async () => {
      const MAX_SLOT = 2n ** 64n - 1n;
      const MAX_AMOUNT = 2n ** 128n - 1n;
      const packed = await slotDepositPacking.pack(MAX_SLOT, MAX_AMOUNT);
      const unpacked = await slotDepositPacking.unpack(packed);
      expect(unpacked.slot).to.equal(MAX_SLOT);
      expect(unpacked.depositedEth).to.equal(MAX_AMOUNT);
    });
  });

  context("DepositTracker", () => {
    context("insertSlotDeposit", () => {
      it("reverts on slot too large", async () => {
        const TOO_BIG_SLOT = 2n ** 64n;
        await expect(depositTracker.insertSlotDeposit(TOO_BIG_SLOT, 1)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotTooLarge",
        );
      });

      it("Revert on amount too large", async () => {
        const TOO_BIG_AMT = 2n ** 128n;
        await expect(depositTracker.insertSlotDeposit(1, TOO_BIG_AMT)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "DepositAmountTooLarge",
        );
      });

      it("Reverts on zero amount", async () => {
        await expect(depositTracker.insertSlotDeposit(1, 0)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "ZeroValue",
        );
      });

      it("Creates single entry and sets total", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        const total = await depositTracker.getTotalAmount();
        expect(total).to.equal(5);
        const [slots, amounts] = await depositTracker.getSlotsDepositsUnpacked();
        expect(slots.length).to.equal(1);
        expect(slots[0]).to.equal(1000);
        expect(amounts[0]).to.equal(5);
      });

      it("Same slot insert: aggregates deposit and increases total", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1000, 7);
        const total = await depositTracker.getTotalAmount();
        expect(total).to.equal(12);
        const [slots, amounts] = await depositTracker.getSlotsDepositsUnpacked();
        expect(slots.length).to.equal(1);
        expect(slots[0]).to.equal(1000);
        expect(amounts[0]).to.equal(12);
      });

      it("New slot insert: appends slot and increase total", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1002, 3);
        const total = await depositTracker.getTotalAmount();
        expect(total).to.equal(8);
        const [slots, amounts] = await depositTracker.getSlotsDepositsUnpacked();
        expect(slots).to.deep.equal([1000n, 1002n]);
        expect(amounts).to.deep.equal([5n, 3n]);
      });

      it("out-of-order slot reverts", async () => {
        await depositTracker.insertSlotDeposit(5000, 1);
        await expect(depositTracker.insertSlotDeposit(4999, 1)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotOutOfOrder",
        );
      });
    });

    context("getDepositedEth", () => {
      it("returns 0 when no entries", async () => {
        const r = await depositTracker.getDepositedEth.staticCall(1234);
        expect(r).to.equal(0);
        const cursor = await depositTracker.getIndexOfLastRead.staticCall();
        // still sentinel

        // should be max uint128
        expect(cursor).to.equal(0);
      });

      it("includes exact _slot and advances cursor", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1001, 7);
        await depositTracker.insertSlotDeposit(1003, 3);

        // cursor sentinel after first insert
        expect(await depositTracker.getIndexOfLastRead()).to.equal(ethers.MaxUint256);

        // peek value (no state change), then execute and wait (state change)
        expect(await depositTracker.getDepositedEth.staticCall(1000)).to.equal(5);
        await (await depositTracker.getDepositedEth(1000)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(0);

        expect(await depositTracker.getDepositedEth.staticCall(1001)).to.equal(7);
        await (await depositTracker.getDepositedEth(1001)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(1);

        expect(await depositTracker.getDepositedEth.staticCall(10_000)).to.equal(3);
        await (await depositTracker.getDepositedEth(10_000)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(2);

        // nothing left
        expect(await depositTracker.getDepositedEth.staticCall(10_000)).to.equal(0);
        await (await depositTracker.getDepositedEth(10_000)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(2);
      });

      it("sums up to but not beyond _slot (inclusive)", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        // include 10 and 20 (<= 25), cursor -> 1
        expect(await depositTracker.getDepositedEth.staticCall(25)).to.equal(3);
        await (await depositTracker.getDepositedEth(25)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(1);

        // same bound again -> nothing new, cursor unchanged
        expect(await depositTracker.getDepositedEth.staticCall(25)).to.equal(0);
        await (await depositTracker.getDepositedEth(25)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(1);

        // now include 30, cursor -> 2
        expect(await depositTracker.getDepositedEth.staticCall(30)).to.equal(3);
        await (await depositTracker.getDepositedEth(30)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(2);
      });

      it("aggregated same-slot deposit is counted once and included", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1000, 7); // aggregates to 12

        // peek (no state change)
        expect(await depositTracker.getDepositedEth.staticCall(1000)).to.equal(12);

        // advance (state change)
        await (await depositTracker.getDepositedEth(1000)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(0);
      });

      it("reverts with SlotOutOfRange if _slot is behind the cursor slot", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        // consume everything (cursor -> 2 at slot 30)
        expect(await depositTracker.getDepositedEth.staticCall(30)).to.equal(6);
        await (await depositTracker.getDepositedEth(30)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(2);

        // now ask for a smaller slot than cursor's slot -> revert (stateful)
        await expect(depositTracker.getDepositedEth(15)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotOutOfRange",
        );
      });

      it("returns 0 if cursor is already at the last element", async () => {
        await depositTracker.insertSlotDeposit(1, 10);
        await depositTracker.insertSlotDeposit(2, 20);

        // consume all (cursor -> 1)
        expect(await depositTracker.getDepositedEth.staticCall(2)).to.equal(30);
        await (await depositTracker.getDepositedEth(2)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(1);

        // any further reads return 0
        expect(await depositTracker.getDepositedEth.staticCall(999_999)).to.equal(0);
        await (await depositTracker.getDepositedEth(999_999)).wait();
        expect(await depositTracker.getIndexOfLastRead()).to.equal(1);
      });
    });
  });
});
