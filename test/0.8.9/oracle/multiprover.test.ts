import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Multiprover, ZkOracleMock } from "typechain-types";

// pnpm hardhat test --grep "Multiprover"

describe("Multiprover.sol", () => {
  let multiprover: Multiprover;
  let deployer: HardhatEthersSigner;

  const log = console.log;
  // const log = () => {}

  beforeEach(async () => {
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

  context("Multiprover quorum", () => {
    it(`can set quorum`, async () => {
      const role = await multiprover.MANAGE_MEMBERS_AND_QUORUM_ROLE();
      log("role", role);
      await multiprover.grantRole(role, deployer);

      await expect(multiprover.setQuorum(1)).to.emit(multiprover, "QuorumSet").withArgs(1, 0, 0);
      const quorum = await multiprover.getQuorum();
      expect(quorum).to.equal(1);

      await expect(multiprover.addMember(deployer, 1)).to.emit(multiprover, "MemberAdded").withArgs(deployer, 1, 1);

      await expect(multiprover.addMember(deployer, 2)).to.be.revertedWithCustomError(multiprover, "DuplicateMember");

      await expect(multiprover.setQuorum(0))
        .to.be.revertedWithCustomError(multiprover, "QuorumTooSmall")
        .withArgs(1, 0);

      await expect(multiprover.removeMember(deployer, 1))
        .to.emit(multiprover, "MemberRemoved")
        .withArgs(deployer, 0, 1);
    });
  });

  context("Multiprover getResult()", () => {
    let oracleMock: ZkOracleMock;
    beforeEach(async () => {
      oracleMock = await ethers.deployContract("ZkOracleMock");
      await oracleMock.addReport(0x01, { success: true, clBalanceGwei: 1, numValidators: 2, exitedValidators: 3 });

      const role = await multiprover.MANAGE_MEMBERS_AND_QUORUM_ROLE();
      await multiprover.grantRole(role, deployer);
    });

    it(`can get result`, async () => {
      await multiprover.addMember(oracleMock.getAddress(), 1);

      const report = await multiprover.getReport(0x01);
      expect(report.success).to.be.true;
      expect(report.clBalanceGwei).to.equal(1);
      expect(report.numValidators).to.equal(2);
      expect(report.exitedValidators).to.equal(3);
    });

    it(`can get result from 2 oracles`, async () => {
      const oracle2Mock: ZkOracleMock = await ethers.deployContract("ZkOracleMock");
      await oracle2Mock.addReport(0x01, { success: true, clBalanceGwei: 1, numValidators: 2, exitedValidators: 3 });

      await multiprover.addMember(oracleMock.getAddress(), 1);
      await multiprover.addMember(oracle2Mock.getAddress(), 2);

      const report = await multiprover.getReport(0x01);
      expect(report.success).to.be.true;
      expect(report.clBalanceGwei).to.equal(1);
      expect(report.numValidators).to.equal(2);
      expect(report.exitedValidators).to.equal(3);
    });

    it(`can't get result from 2 different oracle reports`, async () => {
      const oracle2Mock: ZkOracleMock = await ethers.deployContract("ZkOracleMock");
      await oracle2Mock.addReport(0x01, { success: true, clBalanceGwei: 2, numValidators: 2, exitedValidators: 3 });

      await multiprover.addMember(oracleMock.getAddress(), 1);
      await multiprover.addMember(oracle2Mock.getAddress(), 2);

      await expect(multiprover.getReport(0x01)).to.be.revertedWithCustomError(multiprover, "NoConsensus");
    });
  });
});
