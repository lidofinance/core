import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Tiebreaker } from "typechain-types";

// pnpm hardhat test --grep "Tiebreaker"

describe("Tiebreaker.sol", () => {
  let tiebreaker: Tiebreaker;
  let deployer: HardhatEthersSigner;

  // const log = console.log;
  // const log = () => {}

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();
    tiebreaker = await ethers.deployContract("Tiebreaker", [deployer.address]);
  });

  context("Tiebreaker is functional", () => {
    it(`can submit report`, async () => {
      await tiebreaker.submitReport(0x01, true, 2, 3, 4);
      const result = await tiebreaker.getReport(0x01);
      expect(result).to.deep.equal([true, 2n, 3n, 4n]);

      const result2 = await tiebreaker.getReport(0x02);
      expect(result2).to.deep.equal([false, 0n, 0n, 0n]);
    });

    it(`can remove report`, async () => {
      await tiebreaker.submitReport(0x05, true, 2, 3, 4);
      const result = await tiebreaker.getReport(0x05);
      expect(result).to.deep.equal([true, 2n, 3n, 4n]);

      await tiebreaker.removeReport(0x05);
      const result2 = await tiebreaker.getReport(0x05);
      expect(result2).to.deep.equal([false, 0n, 0n, 0n]);
    });
  });
});
