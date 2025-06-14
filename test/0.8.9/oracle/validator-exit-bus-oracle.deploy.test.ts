import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness, ValidatorsExitBusOracle } from "typechain-types";

import { SECONDS_PER_SLOT, VEBO_CONSENSUS_VERSION } from "lib";

import { deployVEBO, initVEBO } from "test/deploy";

describe("ValidatorsExitBusOracle.sol:deploy", () => {
  context("Deployment and initial configuration", () => {
    let admin: HardhatEthersSigner;
    let defaultOracle: ValidatorsExitBusOracle;

    before(async () => {
      [admin] = await ethers.getSigners();
      defaultOracle = (await deployVEBO(admin.address)).oracle;
    });

    it("initialize reverts if admin address is zero", async () => {
      const deployed = await deployVEBO(admin.address);

      const maxValidatorsPerReport = 50;
      const maxExitRequestsLimit = 100;
      const exitsPerFrame = 1;
      const frameDuration = 48;

      await expect(
        deployed.oracle.initialize(
          ZeroAddress,
          await deployed.consensus.getAddress(),
          VEBO_CONSENSUS_VERSION,
          0,
          maxValidatorsPerReport,
          maxExitRequestsLimit,
          exitsPerFrame,
          frameDuration,
        ),
      ).to.be.revertedWithCustomError(defaultOracle, "AdminCannotBeZero");
    });

    it("reverts when slotsPerSecond is zero", async () => {
      await expect(deployVEBO(admin.address, { secondsPerSlot: 0n })).to.be.revertedWithCustomError(
        defaultOracle,
        "SecondsPerSlotCannotBeZero",
      );
    });

    context("deployment and init finishes successfully (default setup)", async () => {
      let consensus: HashConsensus__Harness;
      let oracle: ValidatorsExitBus__Harness;

      before(async () => {
        const deployed = await deployVEBO(admin.address);

        await initVEBO({
          admin: admin.address,
          oracle: deployed.oracle,
          consensus: deployed.consensus,
        });

        consensus = deployed.consensus;
        oracle = deployed.oracle;
      });

      it("mock time-travellable setup is correct", async () => {
        const time1 = await consensus.getTime();
        expect(await oracle.getTime()).to.equal(time1);

        await consensus.advanceTimeBy(SECONDS_PER_SLOT);

        const time2 = await consensus.getTime();
        expect(time2).to.equal(time1 + SECONDS_PER_SLOT);
        expect(await oracle.getTime()).to.equal(time2);
      });

      it("initial configuration is correct", async () => {
        expect(await oracle.getConsensusContract()).to.equal(await consensus.getAddress());
        expect(await oracle.getConsensusVersion()).to.equal(VEBO_CONSENSUS_VERSION);
        expect(await oracle.SECONDS_PER_SLOT()).to.equal(SECONDS_PER_SLOT);
        expect(await oracle.isPaused()).to.equal(true);
      });

      it("pause/resume operations work", async () => {
        expect(await oracle.isPaused()).to.equal(true);
        await oracle.resume();
        expect(await oracle.isPaused()).to.equal(false);
        await oracle.pauseFor(123);
        expect(await oracle.isPaused()).to.equal(true);
      });
    });
  });
});
