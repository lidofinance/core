import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { WithdrawalsManagerStub } from "typechain-types";

import { ether } from "lib";

describe("WithdrawalsManagerProxy.sol:stub", () => {
  let deployer: HardhatEthersSigner;
  let sender: HardhatEthersSigner;

  let stub: WithdrawalsManagerStub;

  before(async () => {
    [deployer, sender] = await ethers.getSigners();

    stub = await ethers.deployContract("WithdrawalsManagerStub", deployer);
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
