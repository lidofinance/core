import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, WithdrawalsOracle, WithdrawalsOracle__Harness } from "typechain-types";

import { SECONDS_PER_SLOT, WITHDRAWALS_ORACLE_CONSENSUS_VERSION } from "lib";

import { deployWithdrawalsOracle, initWithdrawalsOracle, MAX_REQUESTS_PER_REPORT } from "test/deploy";

describe("WithdrawalsOracle.sol:deploy", () => {
  context("Deployment and initial configuration", () => {
    let admin: HardhatEthersSigner;
    let defaultOracle: WithdrawalsOracle;

    before(async () => {
      [admin] = await ethers.getSigners();
      defaultOracle = (await deployWithdrawalsOracle(admin.address)).oracle;
    });

    it("initialize reverts if admin address is zero", async () => {
      const deployed = await deployWithdrawalsOracle(admin.address);

      await expect(
        deployed.oracle.initialize(
          ZeroAddress,
          await deployed.consensus.getAddress(),
          WITHDRAWALS_ORACLE_CONSENSUS_VERSION,
          0,
        ),
      ).to.be.revertedWithCustomError(defaultOracle, "AdminCannotBeZero");
    });

    it("reverts when slotsPerSecond is zero", async () => {
      await expect(deployWithdrawalsOracle(admin.address, { secondsPerSlot: 0n })).to.be.revertedWithCustomError(
        defaultOracle,
        "SecondsPerSlotCannotBeZero",
      );
    });

    it("reverts when maxRequestsPerReport is zero", async () => {
      await expect(deployWithdrawalsOracle(admin.address, { maxRequestsPerReport: 0 }))
        .to.be.revertedWithCustomError(defaultOracle, "ZeroArgument")
        .withArgs("maxRequestsPerReport");
    });

    context("deployment and init finishes successfully (default setup)", async () => {
      let consensus: HashConsensus__Harness;
      let oracle: WithdrawalsOracle__Harness;

      before(async () => {
        const deployed = await deployWithdrawalsOracle(admin.address);

        await initWithdrawalsOracle({
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
        expect(await oracle.getConsensusVersion()).to.equal(WITHDRAWALS_ORACLE_CONSENSUS_VERSION);
        expect(await oracle.SECONDS_PER_SLOT()).to.equal(SECONDS_PER_SLOT);
        expect(await oracle.getContractVersion()).to.equal(4);
        expect(await oracle.MAX_REQUESTS_PER_REPORT()).to.equal(MAX_REQUESTS_PER_REPORT);
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
