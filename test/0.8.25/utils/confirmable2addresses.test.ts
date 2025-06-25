import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Confirmable2Addresses__Harness } from "typechain-types";

describe("Confirmable2Addresses", () => {
  let confirmer1: HardhatEthersSigner;
  let confirmer2: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let confirmable: Confirmable2Addresses__Harness;

  before(async () => {
    [confirmer1, confirmer2, stranger] = await ethers.getSigners();
    confirmable = await ethers.deployContract("Confirmable2Addresses__Harness");
    await confirmable.setConfirmers(confirmer1, confirmer2);
  });

  context("setNumber", () => {
    it("reverts if the caller is not a confirmer", async () => {
      await expect(confirmable.connect(stranger).setNumber(1)).to.be.revertedWithCustomError(
        confirmable,
        "SenderNotMember",
      );
    });

    it("updates the number with two confirmations", async () => {
      // initially the number is 0
      expect(await confirmable.number()).to.be.equal(0);

      // confirmer1 initiates the number change
      await confirmable.connect(confirmer1).setNumber(1);
      // the number is still 0
      expect(await confirmable.number()).to.be.equal(0);

      // confirmer2 confirms the number change
      await confirmable.connect(confirmer2).setNumber(1);
      // the number is now 1
      expect(await confirmable.number()).to.be.equal(1);
    });
  });
});
