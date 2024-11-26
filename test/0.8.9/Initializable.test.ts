import { expect } from "chai";
import { ethers } from "hardhat";

import { Initializable__Mock } from "typechain-types";

import { Snapshot } from "test/suite";

describe("Initializable.sol", function () {
  let initializable: Initializable__Mock;

  let originalState: string;

  before(async function () {
    initializable = await ethers.deployContract("Initializable__Mock");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Initialization", function () {
    it("Should emit Initialized event", async function () {
      await expect(initializable.initialize(1)).to.emit(initializable, "Initialized").withArgs(1);
    });

    it("Should set version correctly", async function () {
      await initializable.initialize(1);
      const version = await initializable.version();
      expect(version).to.equal(1);
    });

    it("Should fail if initialize twice", async function () {
      await initializable.initialize(1);
      await expect(initializable.initialize(1)).to.be.revertedWith("Contract is already initialized");
    });
  });
});
