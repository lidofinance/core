import { expect } from "chai";
import { Signer, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HashConsensus, ReportProcessor__Mock } from "typechain-types";

import {
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib";

import { deployHashConsensus } from "test/deploy";

describe("HashConsensus.sol:deploy", function () {
  let admin: Signer;
  let consensus: HashConsensus;
  let mockReportProcessor: ReportProcessor__Mock;

  before(async () => {
    [admin] = await ethers.getSigners();
    mockReportProcessor = await ethers.deployContract("ReportProcessor__Mock", [CONSENSUS_VERSION], admin);
  });

  context("Deployment and initial configuration", () => {
    const INITIAL_EPOCH = 3n;

    it("deploying hash consensus", async () => {
      const deployed = await deployHashConsensus(await admin.getAddress(), { initialEpoch: INITIAL_EPOCH });
      consensus = deployed.consensus;
    });

    it("chain config is correct", async () => {
      const config = await consensus.getChainConfig();
      expect(config.slotsPerEpoch).to.equal(SLOTS_PER_EPOCH);
      expect(config.secondsPerSlot).to.equal(SECONDS_PER_SLOT);
      expect(config.genesisTime).to.equal(GENESIS_TIME);
    });

    it("frame config is correct", async () => {
      const config = await consensus.getFrameConfig();
      expect(config.initialEpoch).to.equal(INITIAL_EPOCH);
      expect(config.epochsPerFrame).to.equal(EPOCHS_PER_FRAME);
    });

    it("reverts if report processor address is zero", async () => {
      await expect(
        ethers.deployContract("HashConsensus__Harness", [
          SLOTS_PER_EPOCH,
          SECONDS_PER_SLOT,
          GENESIS_TIME,
          EPOCHS_PER_FRAME,
          INITIAL_FAST_LANE_LENGTH_SLOTS,
          admin,
          ZeroAddress,
        ]),
      ).to.be.revertedWithCustomError(consensus, "ReportProcessorCannotBeZero()");
    });

    it("reverts if admin address is zero", async () => {
      await expect(
        ethers.deployContract("HashConsensus__Harness", [
          SLOTS_PER_EPOCH,
          SECONDS_PER_SLOT,
          GENESIS_TIME,
          EPOCHS_PER_FRAME,
          INITIAL_FAST_LANE_LENGTH_SLOTS,
          ZeroAddress,
          await mockReportProcessor.getAddress(),
        ]),
      ).to.be.revertedWithCustomError(consensus, "AdminCannotBeZero()");
    });
  });
});
