import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { SanityFuseWrapper } from "typechain-types";

import { BLOCK_TIME, days } from "lib/time";

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
      const reportsOnStart = await fuse.getSuccessfulReportsCount();
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

    it(`fuse init checks are correct`, async () => {
      await expect(ethers.deployContract("SanityFuseWrapper", [ZeroAddress, 0n])).to.revertedWithCustomError(
        fuse,
        "FuseCommitteeCannotBeZero",
      );

      await expect(ethers.deployContract("SanityFuseWrapper", [deployer.address, 0n])).to.revertedWithCustomError(
        fuse,
        "ExpiryTimestampCannotBeInThePast",
      );

      await expect(
        ethers.deployContract("SanityFuseWrapper", [deployer.address, BigInt(await time.latest()) + BigInt(2 ** 64)]),
      ).to.revertedWithCustomError(fuse, "ExpiryTimestampIsTooDistantFuture");
    });

    it(`fuse after expiration can't be blown`, async () => {
      const shortFuse = await ethers.deployContract("SanityFuseWrapper", [
        deployer.address,
        BigInt(await time.latest()) + BLOCK_TIME,
      ]);
      await shortFuse.consultFuseWrapper(false);
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine", []);

      await expect(shortFuse.blowFuse()).to.revertedWith("SanityFuse: fuse already expired");
    });

    it(`fuse can be blown only if there is unsuccessful report`, async () => {
      await expect(fuse.blowFuse()).to.revertedWith("SanityFuse: fuse can be blown only after unsuccessful report");
    });

    it(`fuse can't be blown twice`, async () => {
      await fuse.consultFuseWrapper(false);
      await expect(fuse.blowFuse()).to.emit(fuse, "FuseBlown");
      await expect(fuse.blowFuse()).to.revertedWith("SanityFuse: fuse already blown");
    });

    it(`fuse consulted and blown work together`, async () => {
      // Blow fuse after unsuccessful report
      await expect(fuse.consultFuseWrapper(false)).to.emit(fuse, "FuseConsulted").withArgs(false, 1);
      await expect(fuse.blowFuse()).to.emit(fuse, "FuseBlown");

      // Fuse is blown. unsuccessful report case
      await expect(fuse.consultFuseWrapper(false)).to.emit(fuse, "FuseConsulted").withArgs(true, 1);

      // Fuse is blown after 1 successful report
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(true, 2);
      // Fuse is blown after 2 successful reports
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(true, 3);
      // Fuse is not blown after 3 successful reports
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(false, 4);
      // Fuse is not blown after more than 3 successful reports
      await expect(fuse.consultFuseWrapper(true)).to.emit(fuse, "FuseConsulted").withArgs(false, 4);
    });
  });
});
