import { expect } from "chai";
import hre from "hardhat";

import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { type HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import type { WithdrawalsManagerStub } from "typechain-types/index.js";

import { ether } from "#lib";

describe("WithdrawalsManagerProxy.sol:stub", () => {
  let ethers: HardhatEthers;

  let deployer: HardhatEthersSigner;
  let sender: HardhatEthersSigner;

  let stub: WithdrawalsManagerStub;

  before(async () => {
    ({ ethers } = await hre.network.getOrCreate());

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
