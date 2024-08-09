import { expect } from "chai";
import { Signer } from "ethers";
import { ethers } from "hardhat";

import { HashConsensusTimeTravellable, MockReportProcessor } from "typechain-types";

import {
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_EPOCH,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib";

import {
  computeEpochFirstSlot,
  computeTimestampAtEpoch,
  deployHashConsensus,
  HASH_1,
  SLOTS_PER_FRAME,
  ZERO_HASH,
} from "test/deploy";

describe("HashConsensus:frames", function () {
  const TEST_INITIAL_EPOCH = 3n;

  let admin: Signer;

  let member1: Signer;
  let member2: Signer;
  let member3: Signer;

  before(async () => {
    [admin, member1, member2, member3] = await ethers.getSigners();
  });

  describe("Frame methods", () => {
    let consensus: HashConsensusTimeTravellable;

    const deploy = async () => {
      const deployed = await deployHashConsensus(await admin.getAddress());
      consensus = deployed.consensus;
    };

    describe("getFrameConfig", () => {
      before(deploy);

      it("should return initial data", async () => {
        const config = await consensus.getFrameConfig();
        expect(config.epochsPerFrame).to.equal(EPOCHS_PER_FRAME);
        expect(config.initialEpoch).to.equal(INITIAL_EPOCH);
        expect(config.fastLaneLengthSlots).to.equal(INITIAL_FAST_LANE_LENGTH_SLOTS);
      });

      it("should return new data", async () => {
        await consensus.setFrameConfig(100, 50);
        const config = await consensus.getFrameConfig();
        expect(config.epochsPerFrame).to.equal(100);
        expect(config.fastLaneLengthSlots).to.equal(50);
        expect(config.initialEpoch).to.equal(INITIAL_EPOCH);
      });
    });

    describe("setFrameConfig", () => {
      beforeEach(deploy);

      it("should set data", async () => {
        await consensus.setFrameConfig(100, 50);
        const config = await consensus.getFrameConfig();
        expect(config.epochsPerFrame).to.equal(100);
        expect(config.fastLaneLengthSlots).to.equal(50);
        expect(config.initialEpoch).to.equal(INITIAL_EPOCH);
      });

      it("should set first epoch in next frame", async () => {
        await consensus.setTimeInEpochs(INITIAL_EPOCH + EPOCHS_PER_FRAME);
        await consensus.setFrameConfig(100, 50);
        const config = await consensus.getFrameConfig();
        expect(config.epochsPerFrame).to.equal(100);
        expect(config.fastLaneLengthSlots).to.equal(50);
        expect(config.initialEpoch).to.equal(EPOCHS_PER_FRAME + 1n);
      });

      it("should revert if epochsPerFrame == 0", async () => {
        await expect(consensus.setFrameConfig(0, 50)).to.be.revertedWithCustomError(
          consensus,
          "EpochsPerFrameCannotBeZero()",
        );
      });

      it("should revert if fastLaneLengthSlots > epochsPerFrame * SLOTS_PER_EPOCH", async () => {
        await expect(consensus.setFrameConfig(1, 50)).to.be.revertedWithCustomError(
          consensus,
          "FastLanePeriodCannotBeLongerThanFrame()",
        );
      });

      it("should revert if epoch < config.initialEpoch", async () => {
        await consensus.setTimeInEpochs(INITIAL_EPOCH - 1n);
        await expect(consensus.setFrameConfig(1, 50)).to.be.revertedWithCustomError(
          consensus,
          "InitialEpochIsYetToArrive()",
        );
      });

      it("should emit FrameConfigSet & FastLaneConfigSet event", async () => {
        const tx = await consensus.setFrameConfig(100, 50);
        await expect(tx).to.emit(consensus, "FrameConfigSet").withArgs(1, 100);
        await expect(tx).to.emit(consensus, "FastLaneConfigSet").withArgs(50);
      });

      it("should not emit FrameConfigSet & FastLaneConfigSet event", async () => {
        const tx = await consensus.setFrameConfig(EPOCHS_PER_FRAME, 0);
        await expect(tx).not.to.emit(consensus, "FrameConfigSet");
        await expect(tx).not.to.emit(consensus, "FastLaneConfigSet");
      });
    });
  });
  context("State before initial epoch", () => {
    let consensus: HashConsensusTimeTravellable;
    let reportProcessor: MockReportProcessor;

    before(async () => {
      const deployed = await deployHashConsensus(await admin.getAddress(), { initialEpoch: null });
      consensus = deployed.consensus;
      reportProcessor = deployed.reportProcessor;
    });

    it("after deploy, the initial epoch is far in the future", async () => {
      const maxTimestamp = BigInt(2) ** BigInt(64) - BigInt(1);
      const maxEpoch = (maxTimestamp - GENESIS_TIME) / SECONDS_PER_SLOT / SLOTS_PER_EPOCH;
      expect((await consensus.getFrameConfig()).initialEpoch).to.be.equal(maxEpoch);

      const initialRefSlot = await consensus.getInitialRefSlot();
      expect(initialRefSlot).to.equal(maxEpoch * SLOTS_PER_EPOCH - 1n);
    });

    it("after deploy, one can update initial epoch", async () => {
      const tx = await consensus.connect(admin).updateInitialEpoch(TEST_INITIAL_EPOCH);
      await expect(tx).to.emit(consensus, "FrameConfigSet").withArgs(TEST_INITIAL_EPOCH, EPOCHS_PER_FRAME);

      const frameConfig = await consensus.getFrameConfig();
      expect(frameConfig.initialEpoch).to.equal(TEST_INITIAL_EPOCH);
      expect(frameConfig.epochsPerFrame).to.equal(EPOCHS_PER_FRAME);
      expect(frameConfig.fastLaneLengthSlots).to.equal(INITIAL_FAST_LANE_LENGTH_SLOTS);

      const initialRefSlot = await consensus.getInitialRefSlot();
      expect(initialRefSlot).to.equal(frameConfig.initialEpoch * SLOTS_PER_EPOCH - 1n);
    });

    it("one cannot update initial epoch so that initial ref slot is less than processed one", async () => {
      await consensus.setTimeInEpochs(TEST_INITIAL_EPOCH - 2n);

      const initialRefSlot = TEST_INITIAL_EPOCH * SLOTS_PER_EPOCH - 1n;
      await reportProcessor.setLastProcessingStartedRefSlot(initialRefSlot + 1n);

      await expect(consensus.connect(admin).updateInitialEpoch(TEST_INITIAL_EPOCH)).to.be.revertedWithCustomError(
        consensus,
        "InitialEpochRefSlotCannotBeEarlierThanProcessingSlot()",
      );

      await reportProcessor.setLastProcessingStartedRefSlot(0);
    });

    it("before the initial epoch arrives, one can update it freely", async () => {
      await consensus.setTimeInEpochs(TEST_INITIAL_EPOCH - 2n);

      await consensus.connect(admin).updateInitialEpoch(TEST_INITIAL_EPOCH - 1n);
      expect((await consensus.getFrameConfig()).initialEpoch).to.be.equal(TEST_INITIAL_EPOCH - 1n);

      await consensus.connect(admin).updateInitialEpoch(TEST_INITIAL_EPOCH);
      expect((await consensus.getFrameConfig()).initialEpoch).to.be.equal(TEST_INITIAL_EPOCH);

      const initialRefSlot = await consensus.getInitialRefSlot();
      expect(initialRefSlot).to.equal(TEST_INITIAL_EPOCH * SLOTS_PER_EPOCH - 1n);
    });

    it("before the initial epoch arrives, members can be added and queried, and quorum changed", async () => {
      await consensus.setTimeInEpochs(TEST_INITIAL_EPOCH - 1n);

      await consensus.connect(admin).addMember(member3, 1);
      expect(await consensus.getIsMember(member3)).to.be.true;
      expect(await consensus.getQuorum()).to.equal(1);

      await consensus.connect(admin).removeMember(member3, 2);
      expect(await consensus.getIsMember(member3)).to.be.false;
      expect(await consensus.getQuorum()).to.equal(2);

      await consensus.connect(admin).addMember(member1, 1);
      await consensus.connect(admin).addMember(member2, 2);
      await consensus.connect(admin).addMember(member3, 2);
      expect(await consensus.getQuorum()).to.equal(2);

      await consensus.connect(admin).setQuorum(4);
      expect(await consensus.getQuorum()).to.equal(4);

      await consensus.connect(admin).setQuorum(3);
      expect(await consensus.getQuorum()).to.equal(3);

      await consensus.connect(admin).removeMember(member3, 3);

      expect(await consensus.getIsMember(member1)).to.be.true;
      expect(await consensus.getIsMember(member2)).to.be.true;
      expect(await consensus.getIsMember(member3)).to.be.false;
      expect(await consensus.getQuorum()).to.equal(3);

      expect(await consensus.getIsMember(admin)).to.be.false;

      const { addresses, lastReportedRefSlots } = await consensus.getMembers();
      expect([...addresses]).to.have.members([await member1.getAddress(), await member2.getAddress()]);
      expect(lastReportedRefSlots.map((x) => x)).to.have.members([0n, 0n]);
    });

    it("but otherwise, the contract is dysfunctional", async () => {
      await expect(consensus.getCurrentFrame()).to.be.revertedWithCustomError(consensus, "InitialEpochIsYetToArrive()");
      await expect(consensus.getConsensusState()).to.be.revertedWithCustomError(
        consensus,
        "InitialEpochIsYetToArrive()",
      );
      await expect(consensus.getConsensusStateForMember(member1)).to.be.revertedWithCustomError(
        consensus,
        "InitialEpochIsYetToArrive()",
      );

      const firstRefSlot = TEST_INITIAL_EPOCH * SLOTS_PER_EPOCH - 1n;
      await expect(
        consensus.connect(member1).submitReport(firstRefSlot, HASH_1, CONSENSUS_VERSION),
      ).to.be.revertedWithCustomError(consensus, "InitialEpochIsYetToArrive()");
    });

    it("after the initial epoch comes, the consensus contract becomes functional", async () => {
      await consensus.setTimeInEpochs(TEST_INITIAL_EPOCH);

      await consensus.connect(admin).setQuorum(2);
      expect(await consensus.getQuorum()).to.equal(2);

      const frame = await consensus.getCurrentFrame();
      expect(frame.refSlot).to.equal(computeEpochFirstSlot(TEST_INITIAL_EPOCH) - 1n);
      expect(frame.reportProcessingDeadlineSlot).to.equal(
        computeEpochFirstSlot(TEST_INITIAL_EPOCH) + SLOTS_PER_FRAME - 1n,
      );

      const consensusState = await consensus.getConsensusState();
      expect(consensusState.consensusReport).to.equal(ZERO_HASH);

      const memberInfo = await consensus.getConsensusStateForMember(member1);
      expect(memberInfo.isMember).to.be.true;
      expect(memberInfo.currentFrameRefSlot).to.equal(frame.refSlot);
      expect(memberInfo.lastMemberReportRefSlot).to.equal(0);

      const tx = await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      await expect(tx)
        .to.emit(consensus, "ReportReceived")
        .withArgs(frame.refSlot, await member1.getAddress(), HASH_1);
    });

    it("after the initial epoch comes, updating it via updateInitialEpoch is not possible anymore", async () => {
      await expect(consensus.connect(admin).updateInitialEpoch(TEST_INITIAL_EPOCH + 1n)).to.be.revertedWithCustomError(
        consensus,
        "InitialEpochAlreadyArrived()",
      );
      await expect(consensus.connect(admin).updateInitialEpoch(TEST_INITIAL_EPOCH - 1n)).to.be.revertedWithCustomError(
        consensus,
        "InitialEpochAlreadyArrived()",
      );
    });
  });

  context("Reporting interval manipulation", () => {
    let consensus: HashConsensusTimeTravellable;

    beforeEach(async () => {
      const deployed = await deployHashConsensus(await admin.getAddress(), { initialEpoch: 1n });
      consensus = deployed.consensus;
      await consensus.connect(admin).addMember(await member1.getAddress(), 1);
    });

    it("crossing frame boundary time advances reference and deadline slots by the frame size", async () => {
      expect(await consensus.getTime()).to.equal(computeTimestampAtEpoch(1n));

      await consensus.setFrameConfig(5, 0);
      expect((await consensus.getFrameConfig()).initialEpoch).to.equal(1);

      /// epochs  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20
      /// before    |-------------r|-------------^|--------------|--------------|
      /// after     |--------------|-------------r|^-------------|--------------|
      ///
      /// notice: this timestamp cannot occur in reality since the time has the discreteness
      /// of SECONDS_PER_SLOT after the Merge; however, we're ignoring this to test the math
      await consensus.setTime(computeTimestampAtEpoch(11n) - 1n);

      const frame = await consensus.getCurrentFrame();
      expect(frame.refSlot).to.equal(computeEpochFirstSlot(6n) - 1n);
      expect(frame.reportProcessingDeadlineSlot).to.equal(computeEpochFirstSlot(11n) - 1n);

      await consensus.setTime(computeTimestampAtEpoch(11n));

      const newFrame = await consensus.getCurrentFrame();
      expect(newFrame.refSlot).to.equal(computeEpochFirstSlot(11n) - 1n);
      expect(newFrame.reportProcessingDeadlineSlot).to.equal(computeEpochFirstSlot(16n) - 1n);
    });

    it("increasing frame size always keeps the current start slot", async () => {
      expect(await consensus.getTime()).to.equal(computeTimestampAtEpoch(1n));

      await consensus.setFrameConfig(5, 0);
      expect((await consensus.getFrameConfig()).initialEpoch).to.equal(1);

      /// we're at the last slot of the frame 1 spanning epochs 6-10
      ///
      ///        epochs  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20
      /// frames before    |-------------r|-------------^|--------------|--------------|
      ///  frames after    |-------------r|-------------^------|--------------------|---
      ///                  |
      /// NOT like this    |-------------------r|-------^-------------|-----------------
      ///
      await consensus.setTime(computeTimestampAtEpoch(11n) - SECONDS_PER_SLOT);

      const frame = await consensus.getCurrentFrame();
      expect(frame.refSlot).to.equal(computeEpochFirstSlot(6n) - 1n);
      expect(frame.reportProcessingDeadlineSlot).to.equal(computeEpochFirstSlot(11n) - 1n);

      await consensus.setFrameConfig(7, 0);

      const newFrame = await consensus.getCurrentFrame();
      expect(newFrame.refSlot).to.equal(computeEpochFirstSlot(6n) - 1n);
      expect(newFrame.reportProcessingDeadlineSlot).to.equal(computeEpochFirstSlot(13n) - 1n);
    });

    it("decreasing the frame size cannot decrease the current reference slot", async () => {
      expect(await consensus.getTime()).to.equal(computeTimestampAtEpoch(1n));

      await consensus.setFrameConfig(5, 0);
      expect((await consensus.getFrameConfig()).initialEpoch).to.equal(1);

      /// we're in the first half of the frame 1 spanning epochs 6-10
      ///
      ///        epochs  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20
      /// frames before    |-------------r|---^----------|--------------|--------------|
      ///  frames after    |-------------r|---^-------|-----------|-----------|--------|
      ///                  |
      /// NOT like this    |----------r|------^----|-----------|-----------|-----------|
      ///
      await consensus.setTime(computeTimestampAtEpoch(7n));

      const frame = await consensus.getCurrentFrame();
      expect(frame.refSlot).to.equal(computeEpochFirstSlot(6n) - 1n);
      expect(frame.reportProcessingDeadlineSlot).to.equal(computeEpochFirstSlot(11n) - 1n);

      await consensus.setFrameConfig(4, 0);

      const newFrame = await consensus.getCurrentFrame();
      expect(newFrame.refSlot).to.equal(computeEpochFirstSlot(6n) - 1n);
      expect(newFrame.reportProcessingDeadlineSlot).to.equal(computeEpochFirstSlot(10n) - 1n);
    });

    it("decreasing the frame size may advance the current reference slot, but at least by the new frame size", async () => {
      expect(await consensus.getTime()).to.equal(computeTimestampAtEpoch(1n));

      await consensus.setFrameConfig(5, 0);
      expect((await consensus.getFrameConfig()).initialEpoch).to.equal(1);

      /// we're at the end of the frame 1 spanning epochs 6-10
      ///
      ///        epochs  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20
      /// frames before    |-------------r|------------^-|--------------|--------------|
      ///  frames after    |--------------|----------r|^----------|-----------|---------
      ///                  |
      /// NOT like this    |-----------|----------r|---^-------|-----------|-----------|
      ///
      await consensus.setTime(computeTimestampAtEpoch(10n));

      const frame = await consensus.getCurrentFrame();
      expect(frame.refSlot).to.equal(computeEpochFirstSlot(6n) - 1n);
      expect(frame.reportProcessingDeadlineSlot).to.equal(computeEpochFirstSlot(11n) - 1n);

      await consensus.setFrameConfig(4, 0);

      const newFrame = await consensus.getCurrentFrame();
      expect(newFrame.refSlot).to.equal(computeEpochFirstSlot(10n) - 1n);
      expect(newFrame.reportProcessingDeadlineSlot).to.equal(computeEpochFirstSlot(14n) - 1n);
    });

    it("a report for the current ref. slot cannot be processed anymore");
    // if (_computeSlotAtTimestamp(timestamp) > frame.reportProcessingDeadlineSlot) {
    // this code branch will not be executed, because we cannot change `DEADLINE_SLOT_OFFSET`
  });
});
