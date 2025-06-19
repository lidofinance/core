import { expect } from "chai";
import { ethers } from "hardhat";

import { HashConsensus__Mock, RefSlotCacheTest } from "typechain-types";

import { Snapshot } from "test/suite";

describe("RefSlotCache.sol", () => {
  let consensus: HashConsensus__Mock;
  let refSlotCacheTest: RefSlotCacheTest;

  let originalState: string;

  const DEFAULT_INITIAL_REF_SLOT = 100n;

  before(async () => {
    consensus = await ethers.deployContract("HashConsensus__Mock", [DEFAULT_INITIAL_REF_SLOT]);

    refSlotCacheTest = await ethers.deployContract("RefSlotCacheTest", [consensus]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Uint112WithRefSlotCache", () => {
    describe("withValueIncrease", () => {
      it("should initialize cache only on first call", async () => {
        const increment = 100n;
        const refSlot = 200n;

        await consensus.setRefSlot(refSlot);

        let storage = await refSlotCacheTest.getUintCacheStorage();
        expect(storage.value).to.equal(0n);
        expect(storage.valueOnRefSlot).to.equal(0n);
        expect(storage.refSlot).to.equal(0n);

        await refSlotCacheTest.increaseUintValue(increment);

        storage = await refSlotCacheTest.getUintCacheStorage();
        expect(storage.value).to.equal(increment);
        expect(storage.valueOnRefSlot).to.equal(0n);
        expect(storage.refSlot).to.equal(refSlot);

        await refSlotCacheTest.increaseUintValue(increment);

        storage = await refSlotCacheTest.getUintCacheStorage();
        expect(storage.value).to.equal(2n * increment);
        expect(storage.valueOnRefSlot).to.equal(0n);
        expect(storage.refSlot).to.equal(refSlot);
      });

      it("should cache previous value when refSlot changes", async () => {
        const initialIncrement = 50n;
        const secondIncrement = 75n;
        const firstRefSlot = 200n;
        const secondRefSlot = 300n;

        // First increment at refSlot 200
        await consensus.setRefSlot(firstRefSlot);
        await refSlotCacheTest.increaseUintValue(initialIncrement);

        // Change to refSlot 300 and increment again
        await consensus.setRefSlot(secondRefSlot);
        await refSlotCacheTest.increaseUintValue(secondIncrement);

        const storage = await refSlotCacheTest.getUintCacheStorage();
        expect(storage.value).to.equal(initialIncrement + secondIncrement);
        expect(storage.valueOnRefSlot).to.equal(initialIncrement);
        expect(storage.refSlot).to.equal(secondRefSlot);
      });

      it("should not update cached value when refSlot stays the same", async () => {
        const firstIncrement = 30n;
        const secondIncrement = 20n;
        const refSlot = 200n;

        await consensus.setRefSlot(refSlot);

        // First increment
        await refSlotCacheTest.increaseUintValue(firstIncrement);

        // Second increment at same refSlot
        await refSlotCacheTest.increaseUintValue(secondIncrement);

        const storage = await refSlotCacheTest.getUintCacheStorage();
        expect(storage.value).to.equal(firstIncrement + secondIncrement);
        expect(storage.valueOnRefSlot).to.equal(0n); // Should remain 0 as it was set initially
        expect(storage.refSlot).to.equal(refSlot);
      });

      it("should handle multiple refSlot changes correctly", async () => {
        const increments = [10n, 20n, 30n];
        const refSlots = [100n, 200n, 300n];

        for (let i = 0; i < increments.length; i++) {
          await consensus.setRefSlot(refSlots[i]);
          await refSlotCacheTest.increaseUintValue(increments[i]);
        }

        const finalStorage = await refSlotCacheTest.getUintCacheStorage();
        expect(finalStorage.value).to.equal(increments[0] + increments[1] + increments[2]);
        expect(finalStorage.valueOnRefSlot).to.equal(increments[0] + increments[1]);
        expect(finalStorage.refSlot).to.equal(refSlots[2]);
      });

      it("should handle refSlot truncation to uint32", async () => {
        const increment = 100n;
        const maxUint32 = 2n ** 32n - 1n;
        const largeRefSlot = maxUint32 + 100n; // Larger than uint32 max
        const expectedTruncatedRefSlot = largeRefSlot & (2n ** 32n - 1n); // Truncate to uint32

        await consensus.setRefSlot(maxUint32);
        await refSlotCacheTest.increaseUintValue(increment);

        let storage = await refSlotCacheTest.getUintCacheStorage();
        expect(storage.refSlot).to.equal(maxUint32);
        expect(storage.value).to.equal(increment);
        expect(storage.valueOnRefSlot).to.equal(0n);

        // next refSlot is larger than uint32 max and truncated version is smaller than previous refSlot
        await consensus.setRefSlot(largeRefSlot);
        await refSlotCacheTest.increaseUintValue(increment);

        storage = await refSlotCacheTest.getUintCacheStorage();
        expect(storage.refSlot).to.equal(expectedTruncatedRefSlot);
        expect(storage.value).to.equal(increment * 2n);
        expect(storage.valueOnRefSlot).to.equal(increment);
      });
    });

    describe("getValueForLastRefSlot", () => {
      it("should return current value when current refSlot is greater than cached refSlot", async () => {
        const increment = 100n;
        const oldRefSlot = 200n;
        const newRefSlot = 300n;

        // Set up cache at oldRefSlot
        await consensus.setRefSlot(oldRefSlot);
        await refSlotCacheTest.increaseUintValue(increment);

        // Move to newRefSlot
        await consensus.setRefSlot(newRefSlot);

        const result = await refSlotCacheTest.getUintValueForLastRefSlot();
        expect(result).to.equal(increment);
      });

      it("should return cached value when current refSlot equals cached refSlot", async () => {
        const firstIncrement = 50n;
        const refSlot = 200n;

        // Set initial value
        await consensus.setRefSlot(refSlot);
        await refSlotCacheTest.increaseUintValue(firstIncrement);

        // Change refSlot to trigger caching
        await consensus.setRefSlot(refSlot + 100n);

        const result = await refSlotCacheTest.getUintValueForLastRefSlot();
        expect(result).to.equal(firstIncrement);
      });

      it("should handle zero cached values correctly", async () => {
        const refSlot = 200n;

        await consensus.setRefSlot(refSlot);

        const result = await refSlotCacheTest.getUintValueForLastRefSlot();
        expect(result).to.equal(0n);
      });
    });
  });

  context("Int112WithRefSlotCache", () => {
    describe("withValueIncrease", () => {
      it("should handle positive increments", async () => {
        const increment = 100;
        const refSlot = 200n;

        await consensus.setRefSlot(refSlot);

        await refSlotCacheTest.increaseIntValue(increment);

        const storage = await refSlotCacheTest.getIntCacheStorage();
        expect(storage.value).to.equal(increment);
        expect(storage.valueOnRefSlot).to.equal(0);
        expect(storage.refSlot).to.equal(refSlot);
      });

      it("should handle negative increments", async () => {
        const positiveIncrement = 100;
        const negativeIncrement = -50;
        const refSlot = 200n;

        await consensus.setRefSlot(refSlot);

        // First add positive value
        await refSlotCacheTest.increaseIntValue(positiveIncrement);

        // Then subtract
        await refSlotCacheTest.increaseIntValue(negativeIncrement);

        const storage = await refSlotCacheTest.getIntCacheStorage();
        expect(storage.value).to.equal(positiveIncrement + negativeIncrement);
        expect(storage.valueOnRefSlot).to.equal(0);
        expect(storage.refSlot).to.equal(refSlot);
      });

      it("should cache previous value when refSlot changes", async () => {
        const initialIncrement = 50;
        const secondIncrement = -25;
        const firstRefSlot = 200n;
        const secondRefSlot = 300n;

        // First increment at refSlot 200
        await consensus.setRefSlot(firstRefSlot);
        await refSlotCacheTest.increaseIntValue(initialIncrement);

        // Change to refSlot 300 and increment again
        await consensus.setRefSlot(secondRefSlot);
        await refSlotCacheTest.increaseIntValue(secondIncrement);

        const storage = await refSlotCacheTest.getIntCacheStorage();
        expect(storage.value).to.equal(initialIncrement + secondIncrement);
        expect(storage.valueOnRefSlot).to.equal(initialIncrement);
        expect(storage.refSlot).to.equal(secondRefSlot);
      });

      it("should not update cached value when refSlot stays the same", async () => {
        const increment = 10n;
        const refSlot = 200n;

        await consensus.setRefSlot(refSlot);

        // First increment
        await refSlotCacheTest.increaseIntValue(increment);

        // Second increment at same refSlot
        await refSlotCacheTest.increaseIntValue(increment);

        const storage = await refSlotCacheTest.getIntCacheStorage();
        expect(storage.value).to.equal(increment * 2n);
        expect(storage.valueOnRefSlot).to.equal(0n); // Should remain 0 as it was set initially
        expect(storage.refSlot).to.equal(refSlot);
      });

      it("should handle multiple refSlot changes correctly", async () => {
        const increments = [10n, -20n, 30n];
        const refSlots = [100n, 200n, 300n];

        for (let i = 0; i < increments.length; i++) {
          await consensus.setRefSlot(refSlots[i]);
          await refSlotCacheTest.increaseIntValue(increments[i]);
        }

        const finalStorage = await refSlotCacheTest.getIntCacheStorage();
        expect(finalStorage.value).to.equal(increments[0] + increments[1] + increments[2]);
        expect(finalStorage.valueOnRefSlot).to.equal(increments[0] + increments[1]);
        expect(finalStorage.refSlot).to.equal(refSlots[2]);
      });

      it("should handle refSlot truncation to uint32", async () => {
        const increment = -100n;
        const maxUint32 = 2n ** 32n - 1n;
        const largeRefSlot = maxUint32 + 100n; // Larger than uint32 max
        const expectedTruncatedRefSlot = largeRefSlot & (2n ** 32n - 1n); // Truncate to uint32

        await consensus.setRefSlot(maxUint32);
        await refSlotCacheTest.increaseIntValue(increment);

        let storage = await refSlotCacheTest.getIntCacheStorage();
        expect(storage.refSlot).to.equal(maxUint32);
        expect(storage.value).to.equal(increment);
        expect(storage.valueOnRefSlot).to.equal(0n);

        // next refSlot is larger than uint32 max and truncated version is smaller than previous refSlot
        await consensus.setRefSlot(largeRefSlot);
        await refSlotCacheTest.increaseIntValue(increment);

        storage = await refSlotCacheTest.getIntCacheStorage();
        expect(storage.refSlot).to.equal(expectedTruncatedRefSlot);
        expect(storage.value).to.equal(increment * 2n);
        expect(storage.valueOnRefSlot).to.equal(increment);
      });

      it("should handle zero increments", async () => {
        const increment = 0;
        const refSlot = 200n;

        await consensus.setRefSlot(refSlot);

        await refSlotCacheTest.increaseIntValue(increment);

        const storage = await refSlotCacheTest.getIntCacheStorage();
        expect(storage.value).to.equal(0);
        expect(storage.valueOnRefSlot).to.equal(0);
        expect(storage.refSlot).to.equal(refSlot);
      });
    });

    describe("getValueForLastRefSlot", () => {
      it("should return current value when current refSlot is greater than cached refSlot", async () => {
        const increment = -100;
        const oldRefSlot = 200n;
        const newRefSlot = 300n;

        // Set up cache at oldRefSlot
        await consensus.setRefSlot(oldRefSlot);
        await refSlotCacheTest.increaseIntValue(increment);

        // Move to newRefSlot
        await consensus.setRefSlot(newRefSlot);

        const result = await refSlotCacheTest.getIntValueForLastRefSlot();
        expect(result).to.equal(increment);
      });

      it("should return cached value when current refSlot equals cached refSlot", async () => {
        const firstIncrement = 50;
        const refSlot = 200n;

        // Set initial value
        await consensus.setRefSlot(refSlot);
        await refSlotCacheTest.increaseIntValue(firstIncrement);

        // Change refSlot to trigger caching
        await consensus.setRefSlot(refSlot + 100n);

        const result = await refSlotCacheTest.getIntValueForLastRefSlot();
        expect(result).to.equal(firstIncrement);
      });
    });
  });

  context("Edge cases", () => {
    it("should handle maximum uint112 values", async () => {
      const maxUint112 = 2n ** 112n - 1n;
      const refSlot = 200n;

      await consensus.setRefSlot(refSlot);
      await refSlotCacheTest.increaseUintValue(maxUint112);

      const storage = await refSlotCacheTest.getUintCacheStorage();
      expect(storage.value).to.equal(maxUint112);
    });

    it("should handle maximum int112 values", async () => {
      const maxInt112 = 2n ** 111n - 1n;
      const refSlot = 200n;

      await consensus.setRefSlot(refSlot);
      await refSlotCacheTest.increaseIntValue(maxInt112);

      const storage = await refSlotCacheTest.getIntCacheStorage();
      expect(storage.value).to.equal(maxInt112);
    });

    it("should handle minimum int112 values", async () => {
      const minInt112 = -(2n ** 111n);
      const refSlot = 200n;

      await consensus.setRefSlot(refSlot);
      await refSlotCacheTest.increaseIntValue(minInt112);

      const storage = await refSlotCacheTest.getIntCacheStorage();
      expect(storage.value).to.equal(minInt112);
    });

    it("should handle consensus contract change", async () => {
      const increment = 100n;
      const refSlot1 = 200n;
      const refSlot2 = 300n;

      // Setup with first consensus
      await consensus.setRefSlot(refSlot1);
      await refSlotCacheTest.increaseUintValue(increment);

      // Deploy new consensus contract
      const newConsensus = await ethers.deployContract("HashConsensus__Mock", [DEFAULT_INITIAL_REF_SLOT]);

      await newConsensus.setRefSlot(refSlot2);
      await refSlotCacheTest.setConsensus(newConsensus);

      await refSlotCacheTest.increaseUintValue(increment);

      // Should treat as new refSlot due to different consensus contract
      const storage = await refSlotCacheTest.getUintCacheStorage();
      expect(storage.value).to.equal(increment * 2n);
      expect(storage.valueOnRefSlot).to.equal(increment);
      expect(storage.refSlot).to.equal(refSlot2);
    });
  });
});
