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
  });
});
