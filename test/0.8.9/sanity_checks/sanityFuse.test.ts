import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { SanityFuseWrapper } from "typechain-types";

import { days } from "lib/time";

// pnpm hardhat test --grep "SanityFuse"

describe("SanityFuse.sol", () => {
  let deployer: HardhatEthersSigner;
  let fuse: SanityFuseWrapper;

  // const log = console.log;
  // const log = () => {}

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    const disarmedTimestamp = BigInt(await time.latest()) + days(14n);

    fuse = await ethers.deployContract("SanityFuseWrapper", [deployer.address, disarmedTimestamp]);
  });

  context("SanityFuse is functional", () => {
    it(`base parameters are correct`, async () => {
      const reportsOnStart = await fuse.getSuccessfulReports();
      expect(reportsOnStart).to.equal(0);

      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(false, 1);
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(false, 2);
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(false, 3);
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(false, 4);
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(false, 4);
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(false, 4);

      await expect(fuse.consultFuseWrapper(false)).to.emit(fuse, "FuseConsulted").withArgs(false, 1);
      await expect(fuse.consultFuseWrapper(false)).to.emit(fuse, "FuseConsulted").withArgs(false, 1);
    });
  });
});
