import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Lido } from "typechain-types";

import { deployLidoDao } from "test/deploy";

describe("Lido:Pausable", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;

  beforeEach(async () => {
    [deployer, user, stranger] = await ethers.getSigners();

    ({ lido, acl } = await deployLidoDao({ rootAccount: deployer, initialized: true }));

    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.STAKING_PAUSE_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);

    lido = lido.connect(user);
  });

  context("resumeStaking", () => {
    it("Resumes staking", async () => {
      expect(await lido.isStakingPaused()).to.equal(true);
      await expect(lido.resumeStaking()).to.emit(lido, "StakingResumed");
      expect(await lido.isStakingPaused()).to.equal(false);
    });

    it("Reverts if the caller is unauthorized", async () => {
      await expect(lido.connect(stranger).resumeStaking()).to.be.revertedWith("APP_AUTH_FAILED");
    });
  });

  context("pauseStaking", () => {
    beforeEach(async () => {
      await expect(lido.resumeStaking()).to.emit(lido, "StakingResumed");
      expect(await lido.isStakingPaused()).to.equal(false);
    });

    it("Pauses staking", async () => {
      await expect(lido.pauseStaking()).to.emit(lido, "StakingPaused");
      expect(await lido.isStakingPaused()).to.equal(true);
    });

    it("Reverts if the caller is unauthorized", async () => {
      await expect(lido.connect(stranger).pauseStaking()).to.be.revertedWith("APP_AUTH_FAILED");
    });
  });

  context("isStakingPaused", () => {
    it("Returns true if staking is paused", async () => {
      expect(await lido.isStakingPaused()).to.equal(true);
    });

    it("Returns false if staking is not paused", async () => {
      await lido.resumeStaking();
      expect(await lido.isStakingPaused()).to.equal(false);
    });
  });

  context("resume", () => {
    it("Resumes the contract", async () => {
      await expect(lido.resume()).to.emit(lido, "Resumed").and.to.emit(lido, "StakingResumed");
    });

    it("Reverts if the caller is unauthorized", async () => {
      await expect(lido.connect(stranger).resume()).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if the contract is already resumed", async () => {
      await lido.resume();

      await expect(lido.resume()).to.be.revertedWith("CONTRACT_IS_ACTIVE");
    });
  });

  context("stop", () => {
    beforeEach(async () => {
      await lido.resume();
    });

    it("Stops the contract", async () => {
      await expect(lido.stop()).to.emit(lido, "Stopped").and.to.emit(lido, "StakingPaused");
    });

    it("Reverts if the caller is unauthorized", async () => {
      await expect(lido.connect(stranger).stop()).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if the contract is already stopped", async () => {
      await lido.stop();

      await expect(lido.stop()).to.be.revertedWith("CONTRACT_IS_STOPPED");
    });
  });
});
