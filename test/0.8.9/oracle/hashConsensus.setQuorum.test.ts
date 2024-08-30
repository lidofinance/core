import { expect } from "chai";
import { MaxUint256, Signer } from "ethers";
import { ethers } from "hardhat";

import { HashConsensus, ReportProcessor__Mock } from "typechain-types";

import { CONSENSUS_VERSION, findEventsWithInterfaces } from "lib";

import { deployHashConsensus, DeployHashConsensusParams, HASH_1, ZERO_HASH } from "test/deploy";
import { Snapshot } from "test/suite";

describe("HashConsensus.sol:setQuorum", function () {
  let admin: Signer;
  let member1: Signer;
  let member2: Signer;
  let member3: Signer;

  before(async () => {
    [admin, member1, member2, member3] = await ethers.getSigners();
  });

  describe("setQuorum and addMember changes getQuorum", () => {
    let consensus: HashConsensus;
    let snapshot: string;

    const deployContract = async (options: DeployHashConsensusParams | undefined) => {
      const deployed = await deployHashConsensus(await admin.getAddress(), options);
      consensus = deployed.consensus;

      snapshot = await Snapshot.take();
    };

    const rollback = async () => {
      snapshot = await Snapshot.refresh(snapshot);
    };

    before(() => deployContract({}));

    describe("at deploy quorum is zero and can be set to any number while event is fired on every change", () => {
      it("quorum is zero at deploy", async () => {
        expect(await consensus.getQuorum()).to.equal(0);
      });

      it("quorum is changed, event is fired and getter returns new value", async () => {
        const tx1 = await consensus.setQuorum(1);
        await expect(tx1).to.emit(consensus, "QuorumSet").withArgs(1, 0, 0);
        expect(await consensus.getQuorum()).to.equal(1);
      });

      it("change to same value does not emit event and value is the same", async () => {
        const tx2 = await consensus.setQuorum(1);
        await expect(tx2).not.to.emit(consensus, "QuorumSet");
        expect(await consensus.getQuorum()).to.equal(1);
      });

      it("quorum value changes up and down", async () => {
        const tx3 = await consensus.setQuorum(10);
        await expect(tx3).to.emit(consensus, "QuorumSet").withArgs(10, 0, 1);
        expect(await consensus.getQuorum()).to.equal(10);

        const tx4 = await consensus.setQuorum(5);
        await expect(tx4).to.emit(consensus, "QuorumSet").withArgs(5, 0, 10);
        expect(await consensus.getQuorum()).to.equal(5);
      });
    });

    describe("as new members are added quorum is updated and cannot be set lower than members/2", () => {
      before(rollback);

      it("addMember adds member and updates quorum", async () => {
        expect(await consensus.getQuorum()).to.equal(0);

        const tx1 = await consensus.connect(admin).addMember(await member1.getAddress(), 1);
        await expect(tx1).to.emit(consensus, "QuorumSet").withArgs(1, 1, 0);
        expect(await consensus.getQuorum()).to.equal(1);
      });

      it("setQuorum reverts on value less than members/2", async () => {
        await expect(consensus.setQuorum(0)).to.be.revertedWithCustomError(consensus, "QuorumTooSmall").withArgs(1, 0);

        await consensus.connect(admin).addMember(await member2.getAddress(), 2);
        expect(await consensus.getQuorum()).to.equal(2);

        await expect(consensus.setQuorum(1)).to.be.revertedWithCustomError(consensus, "QuorumTooSmall").withArgs(2, 1);
      });

      it("addMember sets any valid quorum value", async () => {
        await consensus.connect(admin).addMember(await member3.getAddress(), 2);
        expect(await consensus.getQuorum()).to.equal(2);

        await consensus.setQuorum(3);
        expect(await consensus.getQuorum()).to.equal(3);

        await expect(consensus.setQuorum(1)).to.be.revertedWithCustomError(consensus, "QuorumTooSmall").withArgs(2, 1);

        await consensus.setQuorum(2);
        expect(await consensus.getQuorum()).to.equal(2);
      });
    });

    describe("disableConsensus sets unreachable quorum value", () => {
      before(rollback);

      it("disableConsensus updated quorum value and emits events", async () => {
        const UNREACHABLE_QUORUM = MaxUint256;
        const tx = await consensus.disableConsensus();
        await expect(tx).to.emit(consensus, "QuorumSet").withArgs(UNREACHABLE_QUORUM.toString(), 0, 0);
        expect(await consensus.getQuorum()).to.equal(UNREACHABLE_QUORUM);
      });
    });
  });

  describe("setQuorum changes the effective quorum", () => {
    let consensus: HashConsensus;
    let snapshot: string;
    let reportProcessor: ReportProcessor__Mock;
    let frame: Awaited<ReturnType<typeof consensus.getCurrentFrame>>;

    const deployContractWithMembers = async () => {
      const deployed = await deployHashConsensus(await admin.getAddress(), { initialEpoch: 1n });
      consensus = deployed.consensus;
      reportProcessor = deployed.reportProcessor;
      frame = await consensus.getCurrentFrame();

      await consensus.addMember(await member1.getAddress(), 1);
      await consensus.addMember(await member2.getAddress(), 2);
      await consensus.addMember(await member3.getAddress(), 3);

      snapshot = await Snapshot.take();
    };

    const rollback = async () => {
      snapshot = await Snapshot.refresh(snapshot);
    };

    before(deployContractWithMembers);

    describe("quorum increases and changes effective consensus", () => {
      after(rollback);

      it("consensus is reached at 2/3 for quorum of 2", async () => {
        await consensus.setQuorum(2);
        const tx1 = await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx1)
          .to.emit(consensus, "ReportReceived")
          .withArgs(frame.refSlot, await member1.getAddress(), HASH_1);
        await expect(tx1).not.to.emit(consensus, "ConsensusReached");

        const tx2 = await consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx2)
          .to.emit(consensus, "ReportReceived")
          .withArgs(frame.refSlot, await member2.getAddress(), HASH_1);
        await expect(tx2).to.emit(consensus, "ConsensusReached");
        expect((await reportProcessor.getLastCall_submitReport()).callCount).to.equal(1);
      });

      it("quorum increases and effective consensus is changed to none", async () => {
        const tx3 = await consensus.setQuorum(3);
        await expect(tx3).not.to.emit(consensus, "ConsensusReached");
        const consensusState = await consensus.getConsensusState();
        expect(consensusState.consensusReport).to.equal(ZERO_HASH);
        expect(consensusState.isReportProcessing).to.be.false;
      });

      it("report starts processing and it is reflected in getConsensusState", async () => {
        await reportProcessor.startReportProcessing();
        const consensusState = await consensus.getConsensusState();
        expect(consensusState.consensusReport).to.equal(ZERO_HASH);
        expect(consensusState.isReportProcessing).to.be.true;
      });
    });

    describe("setQuorum triggers consensus on decrease", () => {
      after(rollback);

      it("2/3 reports come in", async () => {
        const tx1 = await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx1)
          .to.emit(consensus, "ReportReceived")
          .withArgs(frame.refSlot, await member1.getAddress(), HASH_1);
        await expect(tx1).not.to.emit(consensus, "ConsensusReached");

        const tx2 = await consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx2)
          .to.emit(consensus, "ReportReceived")
          .withArgs(frame.refSlot, await member2.getAddress(), HASH_1);
        await expect(tx2).not.to.emit(consensus, "ConsensusReached");
      });

      it("quorum decreases and consensus is reached", async () => {
        const tx3 = await consensus.setQuorum(2);
        await expect(tx3).to.emit(consensus, "ConsensusReached");

        const receipt = (await tx3.wait())!;
        const consensusReachedEvents = findEventsWithInterfaces(receipt!, "ConsensusReached", [consensus.interface]);
        expect(consensusReachedEvents.length).to.equal(1);

        const consensusState = await consensus.getConsensusState();
        expect(consensusState.consensusReport).to.equal(HASH_1);
      });
    });

    describe("setQuorum can lead to consensus loss on quorum increase", () => {
      after(rollback);

      it("2/3 members reach consensus with quorum of 2", async () => {
        await consensus.setQuorum(2);
        const tx1 = await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx1)
          .to.emit(consensus, "ReportReceived")
          .withArgs(frame.refSlot, await member1.getAddress(), HASH_1);
        await expect(tx1).not.to.emit(consensus, "ConsensusReached");

        const tx2 = await consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx2)
          .to.emit(consensus, "ReportReceived")
          .withArgs(frame.refSlot, await member2.getAddress(), HASH_1);
        await expect(tx2).to.emit(consensus, "ConsensusReached");

        const receipt = (await tx2.wait())!;
        const consensusReachedEvents = findEventsWithInterfaces(receipt!, "ConsensusReached", [consensus.interface]);
        expect(consensusReachedEvents.length).to.equal(1);

        expect((await reportProcessor.getLastCall_submitReport()).callCount).to.equal(1);
      });

      it("quorum goes up to 3 and consensus is lost", async () => {
        const tx = await consensus.setQuorum(3);
        await expect(tx).to.emit(consensus, "ConsensusLost").withArgs(frame.refSlot);

        const consensusState = await consensus.getConsensusState();
        expect(consensusState.consensusReport).to.equal(ZERO_HASH);
        expect(consensusState.isReportProcessing).to.be.false;
        expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(1);
      });

      it("quorum goes down, the consensus is reached again", async () => {
        const tx = await consensus.setQuorum(2);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(frame.refSlot, HASH_1, 2);

        const consensusState = await consensus.getConsensusState();
        expect(consensusState.consensusReport).to.equal(HASH_1);
        expect(consensusState.isReportProcessing).to.be.false;
        expect((await reportProcessor.getLastCall_submitReport()).callCount).to.equal(2);
      });
    });

    describe("setQuorum does not re-trigger consensus if hash is already being processed", () => {
      after(rollback);

      it("2/3 members reach consensus with Quorum of 2", async () => {
        await consensus.setQuorum(2);
        const tx1 = await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx1)
          .to.emit(consensus, "ReportReceived")
          .withArgs(frame.refSlot, await member1.getAddress(), HASH_1);
        await expect(tx1).not.to.emit(consensus, "ConsensusReached");

        const tx2 = await consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx2)
          .to.emit(consensus, "ReportReceived")
          .withArgs(frame.refSlot, await member2.getAddress(), HASH_1);

        const receipt = (await tx2.wait())!;
        const consensusReachedEvents = findEventsWithInterfaces(receipt!, "ConsensusReached", [consensus.interface]);
        expect(consensusReachedEvents.length).to.equal(1);
      });

      it("reportProcessor starts processing", async () => {
        await reportProcessor.startReportProcessing();
        const consensusState = await consensus.getConsensusState();
        expect(consensusState.consensusReport).to.equal(HASH_1);
        expect(consensusState.isReportProcessing).to.be.true;
      });

      it("quorum increases while report is processing", async () => {
        const tx = await consensus.setQuorum(3);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");

        const consensusState = await consensus.getConsensusState();
        expect(consensusState.isReportProcessing).to.be.true;
        expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(0);
      });

      it("quorum decreases but no consensus is triggered", async () => {
        const tx = await consensus.setQuorum(2);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await reportProcessor.getLastCall_submitReport()).callCount).to.equal(1);
        expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(0);
      });
    });
  });
});
