import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { WithdrawalsManagerStub, WithdrawalsManagerStub__factory } from "typechain-types";

import { ether } from "lib";

describe("WithdrawalsManagerStub", () => {
  let deployer: HardhatEthersSigner;
  let sender: HardhatEthersSigner;

  let stub: WithdrawalsManagerStub;

  beforeEach(async () => {
    [deployer, sender] = await ethers.getSigners();

    stub = await new WithdrawalsManagerStub__factory(deployer).deploy();
  });

  context("receive", () => {
    it("Reverts", async () => {
      await expect(
        sender.sendTransaction({
          value: ether("1"),
          to: stub,
        }),
      ).to.be.revertedWith("not supported");
    });
  });
});
