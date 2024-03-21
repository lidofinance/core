import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Multiprover } from "typechain-types";

// pnpm hardhat test --grep "Multiprover"

describe("Multiprover.sol", () => {
  let multiprover: Multiprover;
  let deployer: HardhatEthersSigner;

  const log = console.log;
  // const log = () => {}

  before(async () => {
    [deployer] = await ethers.getSigners();
    multiprover = await ethers.deployContract("Multiprover", [deployer.address]);
  });

  context("Multiprover is functional", () => {
    it(`have zero members`, async () => {
      const members = await multiprover.getMembers();
      expect(members.length).to.equal(0);
    });

    it(`can add members`, async () => {
      const role = await multiprover.MANAGE_MEMBERS_AND_QUORUM_ROLE();
      log("role", role);
      await multiprover.grantRole(role, deployer);

      await multiprover.addMember(deployer, 1);

      const members = await multiprover.getMembers();
      expect(members.length).to.equal(1);
    });
  });
});
