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
          "ZeroValue",
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

    context("getDepositedEthUpToSlot / moveCursorToSlot", () => {
      it("returns 0 when no entries", async () => {
        expect(await depositTracker.getDepositedEthUpToSlot(1234)).to.equal(0);
      });

      it("reads ranges; cursor advances only via moveCursorToSlot", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1001, 7);
        await depositTracker.insertSlotDeposit(1003, 3);

        expect(await depositTracker.getCursor()).to.equal(0);

        expect(await depositTracker.getDepositedEthUpToSlot(1000)).to.equal(5);

        await depositTracker.moveCursorToSlot(1000);
        expect(await depositTracker.getCursor()).to.equal(1);

        expect(await depositTracker.getDepositedEthUpToSlot(1001)).to.equal(7);

        await depositTracker.moveCursorToSlot(1001);
        expect(await depositTracker.getCursor()).to.equal(2);

        expect(await depositTracker.getDepositedEthUpToSlot(10_000)).to.equal(3);

        await depositTracker.moveCursorToSlot(1003); // _slot >= last.slot -> cursor = len
        expect(await depositTracker.getCursor()).to.equal(3);

        expect(await depositTracker.getDepositedEthUpToSlot(10_000)).to.equal(0);
      });

      it("sums up to but not beyond _slot (inclusive) and reverts if _slot < first unread", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        // From cursor=0, sum up to 25 => 1+2
        expect(await depositTracker.getDepositedEthUpToSlot(25)).to.equal(3);

        // Move to first element > 20 -> index 2 (slot 30)
        await depositTracker.moveCursorToSlot(20);
        expect(await depositTracker.getCursor()).to.equal(2);

        // Now first unread is slot 30; asking up to 25 should revert
        await expect(depositTracker.getDepositedEthUpToSlot(25)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotOutOfRange",
        );

        // Up to 30 includes only the last unread (3)
        expect(await depositTracker.getDepositedEthUpToSlot(30)).to.equal(3);

        await depositTracker.moveCursorToSlot(30);
        expect(await depositTracker.getCursor()).to.equal(3);
      });

      it("aggregated same-slot deposit counted once", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1000, 7);

        expect(await depositTracker.getDepositedEthUpToSlot(1000)).to.equal(12);

        await depositTracker.moveCursorToSlot(1000);
        expect(await depositTracker.getCursor()).to.equal(1);
      });

      it("reverts with SlotOutOfRange if _slot is behind first unread", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        await depositTracker.moveCursorToSlot(20); // cursor -> 2 (first unread slot 30)
        expect(await depositTracker.getCursor()).to.equal(2);

        await expect(depositTracker.getDepositedEthUpToSlot(15)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotOutOfRange",
        );
      });

      it("returns 0 if everything was read (cursor == len)", async () => {
        await depositTracker.insertSlotDeposit(1, 10);
        await depositTracker.insertSlotDeposit(2, 20);

        await depositTracker.moveCursorToSlot(2); // cursor == len
        expect(await depositTracker.getCursor()).to.equal(2);

        expect(await depositTracker.getDepositedEthUpToSlot(999_999)).to.equal(0);
      });

      it("moveCursorToSlot reverts only when _slot < current cursor slot; otherwise moves or marks all-read", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        // starting state
        expect(await depositTracker.getCursor()).to.equal(0);

        // _slot == cursor slot -> cursor++
        await depositTracker.moveCursorToSlot(10);
        expect(await depositTracker.getCursor()).to.equal(1);

        // _slot < cursor slot -> revert
        await expect(depositTracker.moveCursorToSlot(9)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotOutOfOrder",
        );

        // find first > 25 -> slot 30 (index 2)
        await depositTracker.moveCursorToSlot(25);
        expect(await depositTracker.getCursor()).to.equal(2);

        // _slot >= last slot -> cursor = len (3)
        await depositTracker.moveCursorToSlot(30);
        expect(await depositTracker.getCursor()).to.equal(3);

        // already all read; no-op
        await depositTracker.moveCursorToSlot(5);
        expect(await depositTracker.getCursor()).to.equal(3);
      });
    });
  });
});
