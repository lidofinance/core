import { expect } from "chai";
import { ethers } from "hardhat";

import type { DepositsTracker, DepositsTracker__Harness, SlotDepositPacking__Harness } from "typechain-types";

describe("DepositsTracker.sol", () => {
  let slotDepositPacking: SlotDepositPacking__Harness;
  let depositTracker: DepositsTracker__Harness;
  let depositTrackerLib: DepositsTracker;

  beforeEach(async () => {
    slotDepositPacking = await ethers.deployContract("SlotDepositPacking__Harness");
    // deploy the library so the matcher can reference its custom errors ABI
    depositTrackerLib = await ethers.deployContract("DepositsTracker");
    // harness does internal calls; no library linking needed
    depositTracker = await ethers.deployContract("DepositsTracker__Harness");
  });

  context("SlotDepositPacking", () => {
    it("Min values", async () => {
      const packed = await slotDepositPacking.pack(0n, 0n);
      const [slot, cumulativeEth] = await slotDepositPacking.unpack(packed);
      expect(slot).to.equal(0n);
      expect(cumulativeEth).to.equal(0n);
    });

    it("Max values", async () => {
      const MAX_SLOT = 2n ** 64n - 1n;
      const MAX_CUMULATIVE = 2n ** 192n - 1n;
      const packed = await slotDepositPacking.pack(MAX_SLOT, MAX_CUMULATIVE);
      const [slot, cumulativeEth] = await slotDepositPacking.unpack(packed);
      expect(slot).to.equal(MAX_SLOT);
      expect(cumulativeEth).to.equal(MAX_CUMULATIVE);
    });
  });

  context("DepositsTracker", () => {
    context("insertSlotDeposit", () => {
      it("reverts on slot too large", async () => {
        const TOO_BIG_SLOT = 2n ** 64n;
        await expect(depositTracker.insertSlotDeposit(TOO_BIG_SLOT, 1)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotTooLarge",
        );
      });

      it("reverts on amount too large", async () => {
        const TOO_BIG_AMT = 2n ** 128n;
        await expect(depositTracker.insertSlotDeposit(1, TOO_BIG_AMT)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "DepositAmountTooLarge",
        );
      });

      it("reverts on zero amount", async () => {
        await expect(depositTracker.insertSlotDeposit(1, 0)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "ZeroDepositAmount",
        );
      });

      it("creates single entry and sets cumulative; cursor starts at 0 (next-to-read)", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        const [slots, cumulatives] = await depositTracker.getSlotsDepositsUnpacked();
        expect(slots).to.deep.equal([1000n]);
        expect(cumulatives).to.deep.equal([5n]);
        expect(await depositTracker.getCursor()).to.equal(0);
      });

      it("same-slot deposit increases cumulative", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1000, 7);
        const [, cumulatives] = await depositTracker.getSlotsDepositsUnpacked();
        expect(cumulatives).to.deep.equal([12n]);
      });

      it("new slot appends and cumulative increases", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1002, 3);
        const [slots, cumulatives] = await depositTracker.getSlotsDepositsUnpacked();
        expect(slots).to.deep.equal([1000n, 1002n]);
        expect(cumulatives).to.deep.equal([5n, 8n]);
      });

      it("out-of-order slot reverts", async () => {
        await depositTracker.insertSlotDeposit(5000, 1);
        await expect(depositTracker.insertSlotDeposit(4999, 1)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotOutOfOrder",
        );
      });
    });

    context("getDepositedEthUpToSlot / moveCursorPastSlot", () => {
      it("returns 0 when no entries", async () => {
        expect(await depositTracker.getDepositedEthUpToSlot(1234)).to.equal(0);
      });

      it("reads ranges; cursor advances only via moveCursorPastSlot", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1001, 7);
        await depositTracker.insertSlotDeposit(1003, 3);

        expect(await depositTracker.getCursor()).to.equal(0);

        expect(await depositTracker.getDepositedEthUpToSlot(1000)).to.equal(5);

        await depositTracker.moveCursorPastSlot(1000);
        expect(await depositTracker.getCursor()).to.equal(1);

        expect(await depositTracker.getDepositedEthUpToSlot(1001)).to.equal(7);

        await depositTracker.moveCursorPastSlot(1001);
        expect(await depositTracker.getCursor()).to.equal(2);

        expect(await depositTracker.getDepositedEthUpToSlot(10_000)).to.equal(3);

        await depositTracker.moveCursorPastSlot(1003); // _slot >= last.slot -> cursor = len
        expect(await depositTracker.getCursor()).to.equal(3);

        expect(await depositTracker.getDepositedEthUpToSlot(10_000)).to.equal(0);
      });

      it("sums up to but not beyond _slot (inclusive); returns 0 if _slot < first unread", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        // From cursor=0, sum up to 25 => 1+2
        expect(await depositTracker.getDepositedEthUpToSlot(25)).to.equal(3);

        // Move to first element > 20 -> index 2 (slot 30)
        await depositTracker.moveCursorPastSlot(20);
        expect(await depositTracker.getCursor()).to.equal(2);

        // Now first unread is slot 30; asking up to 25 should return 0
        expect(await depositTracker.getDepositedEthUpToSlot(25)).to.equal(0);

        // Up to 30 includes only the last unread (3)
        expect(await depositTracker.getDepositedEthUpToSlot(30)).to.equal(3);

        await depositTracker.moveCursorPastSlot(30);
        expect(await depositTracker.getCursor()).to.equal(3);
      });

      it("aggregated same-slot deposit counted once", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1000, 7);

        expect(await depositTracker.getDepositedEthUpToSlot(1000)).to.equal(12);

        await depositTracker.moveCursorPastSlot(1000);
        expect(await depositTracker.getCursor()).to.equal(1);
      });

      // it("returns 0 if _slot is behind first unread", async () => {
      //   await depositTracker.insertSlotDeposit(10, 1);
      //   await depositTracker.insertSlotDeposit(20, 2);
      //   await depositTracker.insertSlotDeposit(30, 3);

      //   await depositTracker.moveCursorPastSlot(20); // cursor -> 2 (first unread slot 30)
      //   expect(await depositTracker.getCursor()).to.equal(2);

      //   expect(await depositTracker.getDepositedEthUpToSlot(15)).to.equal(0);
      // });

      // it("returns 0 if everything was read (cursor == len)", async () => {
      //   await depositTracker.insertSlotDeposit(1, 10);
      //   await depositTracker.insertSlotDeposit(2, 20);

      //   await depositTracker.moveCursorPastSlot(2); // cursor == len
      //   expect(await depositTracker.getCursor()).to.equal(2);

      //   expect(await depositTracker.getDepositedEthUpToSlot(999_999)).to.equal(0);
      // });

      it("moveCursorPastSlot: _slot < cursor slot → don't do anything; _slot == cursor slot → cursor++ ; _slot >= last → cursor=len", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        // starting state
        expect(await depositTracker.getCursor()).to.equal(0);

        // _slot == cursor slot -> cursor++
        await depositTracker.moveCursorPastSlot(10);
        expect(await depositTracker.getCursor()).to.equal(1);

        // _slot < cursor slot -> don't do anything
        await depositTracker.moveCursorPastSlot(9);
        expect(await depositTracker.getCursor()).to.equal(1);

        // find first > 25 -> slot 30 (index 2)
        await depositTracker.moveCursorPastSlot(25);
        expect(await depositTracker.getCursor()).to.equal(2);

        // _slot >= last slot -> cursor = len (3)
        await depositTracker.moveCursorPastSlot(30);
        expect(await depositTracker.getCursor()).to.equal(3);

        // already all read; don't do anything
        await depositTracker.moveCursorPastSlot(5);
        expect(await depositTracker.getCursor()).to.equal(3);
      });

      it("getDepositedEthUpToSlot when cursor points to element with same slot as _slot", async () => {
        await depositTracker.insertSlotDeposit(100, 10);
        await depositTracker.insertSlotDeposit(200, 20);
        await depositTracker.insertSlotDeposit(300, 30);

        // cursor = 0, cursor slot = 100, request slot = 100
        // should return cumulative at slot 100 = 10
        expect(await depositTracker.getDepositedEthUpToSlot(100)).to.equal(10);

        // move cursor to index 1 (slot 200)
        await depositTracker.moveCursorPastSlot(100);
        expect(await depositTracker.getCursor()).to.equal(1);

        // cursor = 1, cursor slot = 200, request slot = 200
        // should return difference: cumulative[1] - cumulative[0] = 30 - 10 = 20
        expect(await depositTracker.getDepositedEthUpToSlot(200)).to.equal(20);

        // move cursor to index 2 (slot 300)
        await depositTracker.moveCursorPastSlot(200);
        expect(await depositTracker.getCursor()).to.equal(2);

        // cursor = 2, cursor slot = 300, request slot = 300
        // should return difference: cumulative[2] - cumulative[1] = 60 - 30 = 30
        expect(await depositTracker.getDepositedEthUpToSlot(300)).to.equal(30);
      });
    });

    context("getDepositedEthUpToLastSlot", () => {
      it("returns 0 when no entries", async () => {
        expect(await depositTracker.getDepositedEthUpToLastSlot()).to.equal(0);
      });

      it("returns total cumulative when cursor is 0", async () => {
        await depositTracker.insertSlotDeposit(100, 10);
        await depositTracker.insertSlotDeposit(200, 20);
        await depositTracker.insertSlotDeposit(300, 30);

        // cursor = 0, should return full cumulative = 10 + 20 + 30 = 60
        expect(await depositTracker.getDepositedEthUpToLastSlot()).to.equal(60);
      });

      it("returns remaining cumulative when cursor > 0", async () => {
        await depositTracker.insertSlotDeposit(100, 10);
        await depositTracker.insertSlotDeposit(200, 20);
        await depositTracker.insertSlotDeposit(300, 30);

        // move cursor past first entry
        await depositTracker.moveCursorPastSlot(100);
        expect(await depositTracker.getCursor()).to.equal(1);

        // should return: cumulative[last] - cumulative[cursor-1] = 60 - 10 = 50
        expect(await depositTracker.getDepositedEthUpToLastSlot()).to.equal(50);

        // move cursor past second entry
        await depositTracker.moveCursorPastSlot(200);
        expect(await depositTracker.getCursor()).to.equal(2);

        // should return: 60 - 30 = 30
        expect(await depositTracker.getDepositedEthUpToLastSlot()).to.equal(30);
      });

      it("returns 0 when cursor == length (all read)", async () => {
        await depositTracker.insertSlotDeposit(100, 10);
        await depositTracker.insertSlotDeposit(200, 20);

        // move cursor to end
        await depositTracker.moveCursorPastSlot(200);
        expect(await depositTracker.getCursor()).to.equal(2);

        expect(await depositTracker.getDepositedEthUpToLastSlot()).to.equal(0);
      });

      it("returns single entry value when only one deposit", async () => {
        await depositTracker.insertSlotDeposit(100, 42);

        expect(await depositTracker.getDepositedEthUpToLastSlot()).to.equal(42);
      });
    });

    context("moveCursorPastSlot edge cases", () => {
      it("does nothing when array is empty", async () => {
        await depositTracker.moveCursorPastSlot(100);
        expect(await depositTracker.getCursor()).to.equal(0);
      });

      it("reverts with SlotTooLarge when slot exceeds uint64 max", async () => {
        const TOO_BIG_SLOT = 2n ** 64n;
        await expect(depositTracker.moveCursorPastSlot(TOO_BIG_SLOT)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotTooLarge",
        );
      });

      it("moves cursor correctly when _slot is between two recorded slots", async () => {
        await depositTracker.insertSlotDeposit(100, 10);
        await depositTracker.insertSlotDeposit(200, 20);
        await depositTracker.insertSlotDeposit(300, 30);

        // _slot = 150 is between 100 and 200
        // should move cursor to first element > 150, which is index 1 (slot 200)
        await depositTracker.moveCursorPastSlot(150);
        expect(await depositTracker.getCursor()).to.equal(1);
      });

      it("does not move cursor backwards even if _slot < current cursor slot and cursor == length", async () => {
        await depositTracker.insertSlotDeposit(100, 10);

        // move cursor to end
        await depositTracker.moveCursorPastSlot(100);
        expect(await depositTracker.getCursor()).to.equal(1);

        // try to move with smaller slot - should be no-op since cursor == length
        await depositTracker.moveCursorPastSlot(50);
        expect(await depositTracker.getCursor()).to.equal(1);
      });
    });

    context("oracle frame windows: (prev ref slot, current last frame]", () => {
      it("1) prev ref slot < slot at cursor → no deposits in last frame (sum=0, cursor unchanged)", async () => {
        // deposits: [ (10,1), (20,3), (30,6) ]  cumulative
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        // simulate we've already consumed up to slot 20 → cursor points to index 2 (slot 30)
        await depositTracker.moveCursorPastSlot(20);
        expect(await depositTracker.getCursor()).to.equal(2);
        // First unread slot is 30

        // Current oracle frame ends at 25 (which is < first unread slot 30)
        expect(await depositTracker.getDepositedEthUpToSlot(25)).to.equal(0);

        // Moving with _slot < cursorSlot, no actions required
        await depositTracker.moveCursorPastSlot(25);
        expect(await depositTracker.getCursor()).to.equal(2);
      });

      it("2) there was a deposit during last frame (sum>0; cursor moves to first slot>_slot)", async () => {
        // deposits: (10,5), (15,7), (25,10), (40,14)
        await depositTracker.insertSlotDeposit(10, 5);
        await depositTracker.insertSlotDeposit(15, 2);
        await depositTracker.insertSlotDeposit(25, 3);
        await depositTracker.insertSlotDeposit(40, 4);

        // start fresh
        expect(await depositTracker.getCursor()).to.equal(0);

        // frame ends at 25 → sum from cursor(0) up to 25 (inclusive): 10
        expect(await depositTracker.getDepositedEthUpToSlot(25)).to.equal(10);

        // after moving, cursor should land on first slot > 25 → slot 40 (index 3)
        await depositTracker.moveCursorPastSlot(25);
        expect(await depositTracker.getCursor()).to.equal(3);
      });

      it("3) no deposit since last report and everything already read (cursor==len)", async () => {
        await depositTracker.insertSlotDeposit(100, 1);
        await depositTracker.insertSlotDeposit(200, 2);

        // Mark all read
        await depositTracker.moveCursorPastSlot(200);
        expect(await depositTracker.getCursor()).to.equal(2);

        // Any further frame read should be 0; move is a no-op
        expect(await depositTracker.getDepositedEthUpToSlot(999999)).to.equal(0);
        await depositTracker.moveCursorPastSlot(999999);
        expect(await depositTracker.getCursor()).to.equal(2);
      });

      it("4) deposit happens at the current report slot; included in read; cursor -> len", async () => {
        // deposits up to current report slot 555
        await depositTracker.insertSlotDeposit(500, 10);
        await depositTracker.insertSlotDeposit(555, 7); // deposit exactly at report slot

        // from cursor=0, reading up to 555 must include both → total 17
        expect(await depositTracker.getDepositedEthUpToSlot(555)).to.equal(17);

        // moving with _slot >= lastDepositSlot → cursor == len
        await depositTracker.moveCursorPastSlot(555);
        expect(await depositTracker.getCursor()).to.equal(2);
      });
    });
  });
});
