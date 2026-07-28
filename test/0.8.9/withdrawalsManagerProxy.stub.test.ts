import { expect } from "chai";

import { type HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import type { WithdrawalsManagerStub } from "typechain-types/index.js";

import { ethers } from "lib/hardhat.js";
import { ether } from "lib/units.js";

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
