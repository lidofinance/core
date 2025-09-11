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
      expect(unpacked.cumulativeEth).to.equal(0);
    });

    it("Max values", async () => {
      const MAX_SLOT = 2n ** 64n - 1n;
      const MAX_CUMULATIVE = 2n ** 192n - 1n;
      const packed = await slotDepositPacking.pack(MAX_SLOT, MAX_CUMULATIVE);
      const unpacked = await slotDepositPacking.unpack(packed);
      expect(unpacked.slot).to.equal(MAX_SLOT);
      expect(unpacked.cumulativeEth).to.equal(MAX_CUMULATIVE);
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

      it("Creates single entry and sets cumulative", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        const [slots, cumulatives] = await depositTracker.getSlotsDepositsUnpacked();
        expect(slots.length).to.equal(1);
        expect(slots[0]).to.equal(1000);
        expect(cumulatives[0]).to.equal(5);
        expect(await depositTracker.getCursor()).to.equal(ethers.MaxUint256);
      });

      it("Creates single entry and increase cumulative", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1000, 7);
        const [slots, cumulatives] = await depositTracker.getSlotsDepositsUnpacked();
        expect(slots.length).to.equal(1);
        expect(slots[0]).to.equal(1000);
        expect(cumulatives[0]).to.equal(12);
      });

      it("New slot insert: appends slot and increase total", async () => {
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

    context("getDepositedEth", () => {
      it("returns 0 when no entries", async () => {
        const r = await depositTracker.getDepositedEthUpToSlot(1234);
        expect(r).to.equal(0);
      });

      it("reads deposited eth in the range and advances cursor only when moveCursorToSlot is called", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1001, 7);
        await depositTracker.insertSlotDeposit(1003, 3);

        expect(await depositTracker.getCursor()).to.equal(ethers.MaxUint256);

        expect(await depositTracker.getDepositedEthUpToSlot(1000)).to.equal(5);

        await depositTracker.moveCursorToSlot(1000, 5);
        expect(await depositTracker.getCursor()).to.equal(0);

        expect(await depositTracker.getDepositedEthUpToSlot(1001)).to.equal(7);

        await depositTracker.moveCursorToSlot(1001, 12);
        expect(await depositTracker.getCursor()).to.equal(1);

        expect(await depositTracker.getDepositedEthUpToSlot(10_000)).to.equal(3);

        await depositTracker.moveCursorToSlot(1003, 15);
        expect(await depositTracker.getCursor()).to.equal(2);

        expect(await depositTracker.getDepositedEthUpToSlot(10_000)).to.equal(0);
      });

      it("sums up to but not beyond _slot (inclusive)", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        expect(await depositTracker.getDepositedEthUpToSlot(25)).to.equal(3);

        await depositTracker.moveCursorToSlot(20, 3);
        expect(await depositTracker.getCursor()).to.equal(1);

        expect(await depositTracker.getDepositedEthUpToSlot(25)).to.equal(0);

        expect(await depositTracker.getDepositedEthUpToSlot(30)).to.equal(3);

        await depositTracker.moveCursorToSlot(30, 6);
        expect(await depositTracker.getCursor()).to.equal(2);
      });

      it("aggregated same-slot deposit is counted once and included", async () => {
        await depositTracker.insertSlotDeposit(1000, 5);
        await depositTracker.insertSlotDeposit(1000, 7);

        expect(await depositTracker.getDepositedEthUpToSlot(1000)).to.equal(12);

        await depositTracker.moveCursorToSlot(1000, 12);
        expect(await depositTracker.getCursor()).to.equal(0);
      });

      it("reverts with SlotOutOfRange if _slot is behind the cursor slot", async () => {
        await depositTracker.insertSlotDeposit(10, 1);
        await depositTracker.insertSlotDeposit(20, 2);
        await depositTracker.insertSlotDeposit(30, 3);

        await depositTracker.moveCursorToSlot(30, 6);
        expect(await depositTracker.getCursor()).to.equal(2);

        await expect(depositTracker.getDepositedEthUpToSlot(15)).to.be.revertedWithCustomError(
          depositTrackerLib,
          "SlotOutOfRange",
        );
      });

      it("returns 0 if cursor is already at the last element", async () => {
        await depositTracker.insertSlotDeposit(1, 10);
        await depositTracker.insertSlotDeposit(2, 20);

        await depositTracker.moveCursorToSlot(2, 30);
        expect(await depositTracker.getCursor()).to.equal(1);

        expect(await depositTracker.getDepositedEthUpToSlot(999_999)).to.equal(0);
      });
    });
  });
});
