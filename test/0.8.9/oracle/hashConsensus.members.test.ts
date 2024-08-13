import { expect } from "chai";
import { Signer, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HashConsensusTimeTravellable } from "typechain-types";

import { CONSENSUS_VERSION } from "lib";

import { deployHashConsensus, HASH_1, HASH_2, ZERO_HASH } from "test/deploy";

describe("HashConsensus:members", function() {
  let admin: Signer;
  let member1: Signer;
  let member2: Signer;
  let member3: Signer;
  let member4: Signer;
  let member5: Signer;
  let member6: Signer;
  let stranger: Signer;

  let consensus: HashConsensusTimeTravellable;

  const deploy = async () => {
    const deployed = await deployHashConsensus(await admin.getAddress());
    consensus = deployed.consensus;
  };

  before(async () => {
    [admin, member1, member2, member3, member4, member5, member6, stranger] = await ethers.getSigners();
  });

  describe("initial state", () => {
    before(deploy);

    it("members list is empty", async () => {
      const membersInfo = await consensus.getMembers();
      expect(membersInfo.addresses).to.be.empty;
      expect(membersInfo.lastReportedRefSlots).to.be.empty;

      expect(await consensus.getIsMember(member1)).to.be.false;

      const member1Info = await consensus.getConsensusStateForMember(member1);
      expect(member1Info.isMember).to.be.false;
      expect(member1Info.canReport).to.be.false;
      expect(member1Info.lastMemberReportRefSlot).to.equal(0);
      expect(member1Info.currentFrameMemberReport).to.equal(ZERO_HASH);
    });

    it("quorum is zero", async () => {
      expect(await consensus.getQuorum()).to.equal(0);
    });
  });

  describe("addMember", () => {
    before(deploy);

    it("reverts if member address equals zero", async () => {
      await expect(consensus.connect(admin).addMember(ZeroAddress, 1)).to.be.revertedWithCustomError(
        consensus,
        "AddressCannotBeZero()",
      );
    });

    it("doesn't allow setting quorum to zero", async () => {
      await expect(consensus.connect(admin).addMember(member1, 0))
        .to.be.revertedWithCustomError(consensus, "QuorumTooSmall")
        .withArgs(1n, 0n);
    });

    it("allows to add a member, setting the new quorum", async () => {
      const newQuorum = 1;
      const tx = await consensus.addMember(member1, newQuorum);

      await expect(tx).to.emit(consensus, "MemberAdded").withArgs(member1, 1, newQuorum);
      expect(await consensus.connect(admin).getIsMember(member1)).to.be.true;

      const { addresses, lastReportedRefSlots } = await consensus.getMembers();
      expect([...addresses]).to.have.members([await member1.getAddress()]);
      expect([...lastReportedRefSlots]).to.have.members([0n]);

      const member1Info = await consensus.getConsensusStateForMember(member1);
      expect(member1Info.isMember).to.be.true;
      expect(member1Info.canReport).to.be.true;
      expect(member1Info.lastMemberReportRefSlot).to.equal(0);
      expect(member1Info.currentFrameMemberReport).to.equal(ZERO_HASH);

      expect(await consensus.getQuorum()).to.equal(1);
    });

    it("doesn't allow to add the same member twice", async () => {
      await expect(consensus.addMember(member1, 2, { from: admin })).to.be.revertedWithCustomError(
        consensus,
        "DuplicateMember()",
      );
    });

    it("requires quorum to be more than half of the total members count", async () => {
      await expect(consensus.addMember(member2, 1, { from: admin }))
        .to.be.revertedWithCustomError(consensus, "QuorumTooSmall")
        .withArgs(2n, 1n);
    });

    it("allows setting the quorum more than total members count", async () => {
      const tx = await consensus.addMember(member2, 3, { from: admin });
      await expect(tx).to.emit(consensus, "MemberAdded").withArgs(member2, 2, 3);
      expect(await consensus.getIsMember(member2)).to.be.true;
      expect(await consensus.getQuorum()).to.equal(3);
    });

    it("lowering the quorum while adding a member may trigger consensus", async () => {
      await consensus.addMember(member3, 3, { from: admin });
      await consensus.addMember(member4, 4, { from: admin });

      const { refSlot } = await consensus.getCurrentFrame();

      await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
      await consensus.connect(member2).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
      await consensus.connect(member3).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
      expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

      const tx = await consensus.addMember(member5, 3, { from: admin });
      await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_1, 3);
      expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);
    });

    it("increasing the quorum might trigger consensus loss", async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      const tx = await consensus.connect(admin).addMember(member6, 4);
      await expect(tx).to.emit(consensus, "ConsensusLost").withArgs(refSlot);
    });
  });

  describe("removeMember", () => {
    beforeEach(async () => {
      await deploy();
      await consensus.connect(admin).addMember(await member1.getAddress(), 4);
      await consensus.connect(admin).addMember(await member2.getAddress(), 4);
      await consensus.connect(admin).addMember(await member3.getAddress(), 4);
      await consensus.connect(admin).addMember(await member4.getAddress(), 4);
      await consensus.connect(admin).addMember(await member5.getAddress(), 4);

      const membersInfo = await consensus.getMembers();
      expect([...membersInfo.addresses]).to.have.members([
        await member1.getAddress(),
        await member2.getAddress(),
        await member3.getAddress(),
        await member4.getAddress(),
        await member5.getAddress(),
      ]);
      expect([...membersInfo.lastReportedRefSlots]).to.deep.equal([0, 0, 0, 0, 0]);
    });

    it("removes a member, setting the new quorum", async () => {
      const tx = await consensus.connect(admin).removeMember(await member1.getAddress(), 3);

      await expect(tx).to.emit(consensus, "MemberRemoved").withArgs(member1.getAddress(), 4, 3);
      expect(await consensus.getIsMember(await member1.getAddress())).to.be.false;
      expect(await consensus.getQuorum()).to.equal(3);

      const member1Info = await consensus.getConsensusStateForMember(await member1.getAddress());
      expect(member1Info.isMember).to.be.false;
      expect(member1Info.lastMemberReportRefSlot).to.equal(0);
      expect(member1Info.currentFrameMemberReport).to.equal(ZERO_HASH);
    });

    it("doesn't allow removing a non-member", async () => {
      await expect(consensus.connect(admin).removeMember(await stranger.getAddress(), 4)).to.be.revertedWithCustomError(
        consensus,
        "NonMember()",
      );
    });

    it("doesn't allow removing an already removed member", async () => {
      await consensus.connect(admin).removeMember(await member1.getAddress(), 4);
      await expect(consensus.connect(admin).removeMember(await member1.getAddress(), 4)).to.be.revertedWithCustomError(
        consensus,
        "NonMember()",
      );
    });

    it("allows removing all members", async () => {
      await consensus.connect(admin).removeMember(await member1.getAddress(), 3);
      expect([...(await consensus.getMembers()).addresses]).to.have.members([
        await member2.getAddress(),
        await member3.getAddress(),
        await member4.getAddress(),
        await member5.getAddress(),
      ]);
      expect(await consensus.getQuorum()).to.equal(3);

      await consensus.connect(admin).removeMember(await member3.getAddress(), 2);
      expect([...(await consensus.getMembers()).addresses]).to.have.members([
        await member2.getAddress(),
        await member4.getAddress(),
        await member5.getAddress(),
      ]);
      expect(await consensus.getQuorum()).to.equal(2);

      await consensus.connect(admin).removeMember(await member4.getAddress(), 2);
      expect([...(await consensus.getMembers()).addresses]).to.have.members([
        await member2.getAddress(),
        await member5.getAddress(),
      ]);
      expect(await consensus.getQuorum()).to.equal(2);

      await consensus.connect(admin).removeMember(await member5.getAddress(), 1);
      expect([...(await consensus.getMembers()).addresses]).to.have.members([await member2.getAddress()]);
      expect(await consensus.getQuorum()).to.equal(1);

      await consensus.connect(admin).removeMember(await member2.getAddress(), 1);
      expect([...(await consensus.getMembers()).addresses]).to.be.empty;
      expect(await consensus.getQuorum()).to.equal(1);
    });

    it("removing a member who didn't vote doesn't decrease any report variant's support", async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
      await consensus.connect(member4).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);

      let reportVariants = await consensus.getReportVariants();
      expect([...reportVariants.variants]).to.have.members([HASH_1, HASH_2]);
      expect([...reportVariants.support]).to.deep.equal([1, 1]);

      await consensus.connect(admin).removeMember(await member2.getAddress(), 3);

      reportVariants = await consensus.getReportVariants();
      expect([...reportVariants.variants]).to.have.members([HASH_1, HASH_2]);
      expect([...reportVariants.support]).to.deep.equal([1, 1]);
    });

    it("removing a member who didn't vote can trigger consensus", async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      await consensus.connect(member1).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
      await consensus.connect(member3).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
      await consensus.connect(member4).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);

      const reportVariants = await consensus.getReportVariants();
      expect([...reportVariants.variants]).to.have.members([HASH_2]);
      expect([...reportVariants.support]).to.have.members([3n]);

      const tx = await consensus.connect(admin).removeMember(await member2.getAddress(), 3);

      await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_2, 3);
      expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_2);
    });

    it("removing a member who voted decreases the voted variant's support", async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
      await consensus.connect(member2).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
      await consensus.connect(member4).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
      await consensus.connect(member5).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);

      let reportVariants = await consensus.getReportVariants();
      expect([...reportVariants.variants]).to.have.members([HASH_1, HASH_2]);
      expect([...reportVariants.support]).to.have.ordered.members([1n, 3n]);

      await consensus.connect(admin).removeMember(await member2.getAddress(), 3);

      reportVariants = await consensus.getReportVariants();
      expect([...reportVariants.variants]).to.have.members([HASH_1, HASH_2]);
      expect([...reportVariants.support]).to.have.ordered.members([1n, 2n]);

      expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);
    });

    it("removing a member who voted can trigger consensus loss", async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      await consensus.connect(member1).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
      await consensus.connect(member2).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
      await consensus.connect(member4).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);

      let tx = await consensus.connect(member5).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
      await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_2, 4);
      expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_2);

      let reportVariants = await consensus.getReportVariants();
      expect([...reportVariants.variants]).to.have.members([HASH_2]);
      expect([...reportVariants.support]).to.have.ordered.members([4n]);

      tx = await consensus.connect(admin).removeMember(await member2.getAddress(), 4);
      await expect(tx).to.emit(consensus, "ConsensusLost").withArgs(refSlot);
      expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

      reportVariants = await consensus.getReportVariants();
      expect([...reportVariants.variants]).to.have.members([HASH_2]);
      expect([...reportVariants.support]).to.have.ordered.members([3n]);
    });

    it("allows to remove a member that's the only one who voted for a variant", async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);

      await consensus.connect(admin).removeMember(await member1.getAddress(), 3);

      const reportVariants = await consensus.getReportVariants();
      expect([...reportVariants.variants]).to.have.members([HASH_1]);
      expect([...reportVariants.support]).to.have.ordered.members([0n]);
    });

    context("Re-triggering consensus via members and quorum manipulation", () => {
      beforeEach(deploy);

      it("adding an extra member", async () => {
        await consensus.connect(admin).addMember(await member1.getAddress(), 1);
        await consensus.connect(admin).addMember(await member2.getAddress(), 2);

        const { refSlot } = await consensus.getCurrentFrame();

        let tx = await consensus.connect(member2).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");

        tx = await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_1, 2);
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(admin).addMember(await member3.getAddress(), 3);
        await expect(tx).to.emit(consensus, "ConsensusLost").withArgs(refSlot);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(admin).removeMember(await member3.getAddress(), 2);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_1, 2);
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);
      });

      it("adding an extra member and its deletion", async () => {
        await consensus.connect(admin).addMember(await member1.getAddress(), 1);
        await consensus.connect(admin).addMember(await member2.getAddress(), 2);

        const { refSlot } = await consensus.getCurrentFrame();

        let tx = await consensus.connect(member2).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");

        tx = await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_1, 2);
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(admin).addMember(await member3.getAddress(), 2);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(admin).removeMember(await member3.getAddress(), 2);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);
      });

      it("adding an extra member and its deletion with report", async () => {
        await consensus.connect(admin).addMember(await member1.getAddress(), 1);
        await consensus.connect(admin).addMember(await member2.getAddress(), 2);

        const { refSlot } = await consensus.getCurrentFrame();

        let tx = await consensus.connect(member2).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");

        tx = await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_1, 2);
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(admin).addMember(await member3.getAddress(), 3);
        await expect(tx).to.emit(consensus, "ConsensusLost").withArgs(refSlot);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(member3).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_1, 3);
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(admin).removeMember(await member3.getAddress(), 2);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);
      });

      it("adding an extra 2 members", async () => {
        const { refSlot } = await consensus.getCurrentFrame();

        await consensus.connect(admin).addMember(await member1.getAddress(), 1);
        await consensus.connect(admin).addMember(await member2.getAddress(), 2);
        await consensus.connect(admin).addMember(await member3.getAddress(), 2);

        let tx = await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");

        tx = await consensus.connect(member2).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_1, 2);
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(member3).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(admin).addMember(await member4.getAddress(), 3);
        await expect(tx).to.emit(consensus, "ConsensusLost").withArgs(refSlot);
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(admin).addMember(await member5.getAddress(), 3);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(member4).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(member5).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_2, 3);
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_2);
      });

      it("adding an extra 2 members and deleting one of the members", async () => {
        const { refSlot } = await consensus.getCurrentFrame();

        await consensus.connect(admin).addMember(await member1.getAddress(), 1);
        await consensus.connect(admin).addMember(await member2.getAddress(), 2);
        await consensus.connect(admin).addMember(await member3.getAddress(), 2);

        let tx = await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");

        tx = await consensus.connect(member2).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_1, 2);
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(member3).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);

        tx = await consensus.connect(admin).addMember(await member4.getAddress(), 3);
        await expect(tx).to.emit(consensus, "ConsensusLost").withArgs(refSlot);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(admin).addMember(await member5.getAddress(), 4);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(member4).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(member5).submitReport(refSlot, HASH_2, CONSENSUS_VERSION);
        await expect(tx).not.to.emit(consensus, "ConsensusReached");
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(ZERO_HASH);

        tx = await consensus.connect(admin).removeMember(await member2.getAddress(), 3);
        await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(refSlot, HASH_2, 3);
        await expect(tx).not.to.emit(consensus, "ConsensusLost");
        expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_2);
      });
    });
  });
});
