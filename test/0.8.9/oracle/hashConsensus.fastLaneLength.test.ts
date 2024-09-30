import { expect } from "chai";
import { Signer } from "ethers";
import { ethers } from "hardhat";

import { HashConsensus__Harness } from "typechain-types";

import { deployHashConsensus, DeployHashConsensusParams } from "test/deploy";
import { Snapshot } from "test/suite";

describe("HashConsensus.sol:fastLaneLength", function () {
  let admin: Signer;
  let consensus: HashConsensus__Harness;

  let originalState: string;

  const deploy = async (options?: DeployHashConsensusParams) => {
    [admin] = await ethers.getSigners();
    const deployed = await deployHashConsensus(await admin.getAddress(), options);
    consensus = deployed.consensus;
  };

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initial data", () => {
    it("sets properly", async () => {
      await deploy({ fastLaneLengthSlots: 0n });
      expect((await consensus.getFrameConfig()).fastLaneLengthSlots).to.equal(0);
      await deploy({ fastLaneLengthSlots: 4n });
      expect((await consensus.getFrameConfig()).fastLaneLengthSlots).to.equal(4);
    });
  });

  context("setFastLaneLengthSlots", () => {
    before(() => deploy());

    const getFastLaneLengthSlotsLimit = async () => {
      const { slotsPerEpoch } = await consensus.getChainConfig();
      const { epochsPerFrame } = await consensus.getFrameConfig();
      return slotsPerEpoch * epochsPerFrame;
    };

    it("should revert if fastLaneLengthSlots > epochsPerFrame * slotsPerEpoch", async () => {
      const fastLaneLengthSlots = (await getFastLaneLengthSlotsLimit()) + 1n;
      await expect(consensus.connect(admin).setFastLaneLengthSlots(fastLaneLengthSlots)).to.be.revertedWithCustomError(
        consensus,
        "FastLanePeriodCannotBeLongerThanFrame()",
      );
    });

    it("sets new value properly", async () => {
      const fastLaneLengthSlots = await getFastLaneLengthSlotsLimit();
      await consensus.connect(admin).setFastLaneLengthSlots(fastLaneLengthSlots);
      expect((await consensus.getFrameConfig()).fastLaneLengthSlots).to.equal(fastLaneLengthSlots);
    });

    it("emits FastLaneConfigSet event", async () => {
      const fastLaneLengthSlots = await getFastLaneLengthSlotsLimit();
      const tx = await consensus.connect(admin).setFastLaneLengthSlots(fastLaneLengthSlots);
      await expect(tx).to.emit(consensus, "FastLaneConfigSet").withArgs(fastLaneLengthSlots);
    });

    it("not emits FastLaneConfigSet if new value is the same", async () => {
      const fastLaneLengthSlots = (await consensus.getFrameConfig()).fastLaneLengthSlots;
      const tx = await consensus.connect(admin).setFastLaneLengthSlots(fastLaneLengthSlots);
      await expect(tx).not.to.emit(consensus, "FastLaneConfigSet");
    });
  });
});
