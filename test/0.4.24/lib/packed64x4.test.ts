import { expect } from "chai";
import { ethers } from "hardhat";

import { Packed64x4__Harness } from "typechain-types";

import { Snapshot } from "test/suite";

const OVER_UINT64_MAX = 2n ** 64n;

describe("Packed64x4.sol", () => {
  let packed: Packed64x4__Harness;

  let originalState: string;

  before(async () => {
    packed = await ethers.deployContract("Packed64x4__Harness");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("get", () => {
    it("Returns the value from position", async () => {
      const value = await packed.get(0);
      expect(value).to.equal(0);
    });

    it("Returns 0 when out of bounds", async () => {
      const value = await packed.get(4);
      expect(value).to.equal(0);
    });
  });

  context("set", () => {
    it("Reverts if number is more than 64 bits", async () => {
      await expect(packed.set(0, OVER_UINT64_MAX)).to.be.revertedWith("PACKED_OVERFLOW");
    });

    it("Updates value at different positions", async () => {
      await packed.set(0, 1n);
      await packed.set(1, 2n);
      await packed.set(2, 3n);
      await packed.set(3, 4n);

      expect(await packed.get(0)).to.equal(1n);
      expect(await packed.get(1)).to.equal(2n);
      expect(await packed.get(2)).to.equal(3n);
      expect(await packed.get(3)).to.equal(4n);
    });

    it("Preserves values when updating out of bounds", async () => {
      await packed.set(0, 1n);
      await packed.set(1, 2n);
      await packed.set(2, 3n);
      await packed.set(3, 4n);

      // await packed.set(4, 5n); // FIXME: This should revert?

      expect(await packed.get(0)).to.equal(1n);
      expect(await packed.get(1)).to.equal(2n);
      expect(await packed.get(2)).to.equal(3n);
      expect(await packed.get(3)).to.equal(4n);
    });
  });

  context("add", () => {
    it("Reverts with PACKED_OVERFLOW", async () => {
      await expect(packed.add(0, OVER_UINT64_MAX)).to.be.revertedWith("PACKED_OVERFLOW");
    });

    it("Updates value positions", async () => {
      const before = await packed.get(0);
      await packed.add(0, 1n);

      expect(await packed.get(0)).to.equal(before + 1n);
    });
  });

  context("sub", () => {
    it("Reverts with MATH_SUB_UNDERFLOW", async () => {
      await expect(packed.sub(0, 1n)).to.be.revertedWith("MATH_SUB_UNDERFLOW");
    });

    it("Updates value positions", async () => {
      await packed.set(0, 100n);
      await packed.sub(0, 1n);

      expect(await packed.get(0)).to.equal(99n);
    });
  });
});
