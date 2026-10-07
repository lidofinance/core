import { expect } from "chai";

import type { Math__Harness } from "typechain-types/index.js";

import { ethers } from "#test/suite";

describe("Math.sol", () => {
  let math: Math__Harness;

  before(async () => {
    math = await ethers.deployContract("Math__Harness");
  });

  context("max", () => {
    it("Returns the maximum of two numbers", async () => {
      expect(await math.max(1, 2)).to.equal(2);
      expect(await math.max(2, 1)).to.equal(2);
    });

    it("Returns the maximum for equal numbers", async () => {
      expect(await math.max(1, 1)).to.equal(1);
    });
  });

  context("min", () => {
    it("Returns the minimum of two numbers", async () => {
      expect(await math.min(1, 2)).to.equal(1);
      expect(await math.min(2, 1)).to.equal(1);
    });

    it("Returns the minimum for equal numbers", async () => {
      expect(await math.min(1, 1)).to.equal(1);
    });
  });

  context("pointInHalfOpenIntervalModN", () => {
    it("Returns true if point is in the half-open interval", async () => {
      expect(await math.pointInHalfOpenIntervalModN(2, 1, 3, 5)).to.equal(true);
    });

    it("Returns false if point is not in the half-open interval", async () => {
      expect(await math.pointInHalfOpenIntervalModN(4, 1, 3, 5)).to.equal(false);
    });
  });

  context("pointInClosedIntervalModN", () => {
    it("Returns true if point is in the closed interval", async () => {
      expect(await math.pointInClosedIntervalModN(3, 1, 3, 5)).to.equal(true);
    });

    it("Returns false if point is not in the closed interval", async () => {
      expect(await math.pointInClosedIntervalModN(4, 1, 3, 5)).to.equal(false);
    });
  });
});
