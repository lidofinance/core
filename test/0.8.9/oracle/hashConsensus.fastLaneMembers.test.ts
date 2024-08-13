import { expect } from "chai";
import { Signer } from "ethers";
import { ethers } from "hardhat";

import { HashConsensusTimeTravellable } from "typechain-types";

import { CONSENSUS_VERSION, MAX_UINT256 } from "lib";

import { deployHashConsensus, DeployHashConsensusParams, HASH_1 } from "test/deploy";

const prepareFrameData = async ({
  fastLaneMembers,
  restMembers,
}: {
  fastLaneMembers: number[];
  restMembers: number[];
}): Promise<{ fastLaneMembers: Signer[]; restMembers: Signer[] }> => {
  const signers = await ethers.getSigners();
  return {
    fastLaneMembers: fastLaneMembers.map((index) => signers[index]),
    restMembers: restMembers.map((index) => signers[index]),
  };
};

describe("HashConsensus:Fastlane members", () => {
  let admin: Signer;
  let member1: Signer;
  let member2: Signer;
  let member3: Signer;
  let member4: Signer;
  let member5: Signer;
  let stranger: Signer;
  let consensus: HashConsensusTimeTravellable;

  const deploy = async (options?: DeployHashConsensusParams) => {
    [admin, member1, member2, member3, member4, member5, stranger] = await ethers.getSigners();
    const deployed = await deployHashConsensus(await admin.getAddress(), options);
    consensus = deployed.consensus;
  };

  const setTimeToFrame0 = async () => {
    await consensus.setTimeInEpochs((await consensus.getFrameConfig()).initialEpoch);
    expect(await consensus.getTimeInSlots()).to.equal((await consensus.getCurrentFrame()).refSlot + 1n);
  };

  before(() => deploy());

  context("State after initialization", () => {
    it("nobody is in the fast lane set", async () => {
      expect(await consensus.getIsFastLaneMember(await member1.getAddress())).to.be.false;
      expect((await consensus.getConsensusStateForMember(await member1.getAddress())).isFastLane).to.be.false;

      expect(await consensus.getIsFastLaneMember(await member2.getAddress())).to.be.false;
      expect((await consensus.getConsensusStateForMember(await member2.getAddress())).isFastLane).to.be.false;

      expect(await consensus.getIsFastLaneMember(await member3.getAddress())).to.be.false;
      expect((await consensus.getConsensusStateForMember(await member3.getAddress())).isFastLane).to.be.false;

      const fastLaneMembers = await consensus.getFastLaneMembers();
      expect(fastLaneMembers.addresses).to.be.empty;
    });
  });
  context("Basic scenario", () => {
    const fastLaneLengthSlots = 10n;

    const frames = [
      { fastLaneMembers: [1, 2, 3], restMembers: [4, 5] },
      { fastLaneMembers: [2, 3, 4], restMembers: [5, 1] },
      { fastLaneMembers: [3, 4, 5], restMembers: [1, 2] },
      { fastLaneMembers: [4, 5, 1], restMembers: [2, 3] },
      { fastLaneMembers: [5, 1, 2], restMembers: [3, 4] },
      { fastLaneMembers: [1, 2, 3], restMembers: [4, 5] },
      { fastLaneMembers: [2, 3, 4], restMembers: [5, 1] },
      { fastLaneMembers: [3, 4, 5], restMembers: [1, 2] },
      { fastLaneMembers: [4, 5, 1], restMembers: [2, 3] },
      { fastLaneMembers: [5, 1, 2], restMembers: [3, 4] },
      { fastLaneMembers: [1, 2, 3], restMembers: [4, 5] },
      { fastLaneMembers: [2, 3, 4], restMembers: [5, 1] },
    ];

    before(async () => {
      await deploy({ fastLaneLengthSlots });

      await consensus.addMember(member1, 1, { from: admin });
      await consensus.addMember(member2, 2, { from: admin });
      await consensus.addMember(member3, 2, { from: admin });
      await consensus.addMember(member4, 3, { from: admin });
      await consensus.addMember(member5, 3, { from: admin });
    });

    before(setTimeToFrame0);

    frames.forEach((frameData, index) => {
      context(`frame ${index}`, () => {
        let frame: Awaited<ReturnType<typeof consensus.getCurrentFrame>>;
        let preparedFrameData: { fastLaneMembers: Signer[]; restMembers: Signer[] };

        before(async () => {
          frame = await consensus.getCurrentFrame();
          preparedFrameData = await prepareFrameData(frameData);
        });

        after(async () => {
          await consensus.advanceTimeToNextFrameStart();
        });

        it(`fast lane members are calculated correctly`, async () => {
          for (const member of preparedFrameData.fastLaneMembers) {
            expect(await consensus.getIsFastLaneMember(member)).to.be.true;
            expect((await consensus.getConsensusStateForMember(member)).isFastLane).to.be.true;
          }
          for (const member of preparedFrameData.restMembers) {
            expect(await consensus.getIsFastLaneMember(member)).to.be.false;
            expect((await consensus.getConsensusStateForMember(member)).isFastLane).to.be.false;
          }
          const expectedFastLaneMembers = await Promise.all(
            preparedFrameData.fastLaneMembers.map((m) => m.getAddress()),
          );
          const expectedAllMembers = await Promise.all(
            [...preparedFrameData.fastLaneMembers, ...preparedFrameData.restMembers].map((m) => m.getAddress()),
          );
          // chai is trying to mutate the array so we need to create a new one
          expect([...(await consensus.getFastLaneMembers()).addresses]).to.have.all.members(expectedFastLaneMembers);
          expect([...(await consensus.getMembers()).addresses]).to.have.all.members(expectedAllMembers);
        });

        it("non-members are not in the fast lane set", async () => {
          expect(await consensus.getIsFastLaneMember(stranger)).to.be.false;
          expect((await consensus.getConsensusStateForMember(stranger)).isFastLane).to.be.false;
        });

        it(`fast lane members can submit a report in the first part of the frame`, async () => {
          const { fastLaneMembers } = preparedFrameData;

          expect((await consensus.getConsensusStateForMember(fastLaneMembers[0].getAddress())).canReport).to.be.true;
          await expect(
            consensus.connect(fastLaneMembers[0]).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION),
          ).to.emit(consensus, "ReportReceived");

          expect((await consensus.getConsensusStateForMember(fastLaneMembers[1].getAddress())).canReport).to.be.true;
          await expect(
            consensus.connect(fastLaneMembers[1]).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION),
          ).to.emit(consensus, "ReportReceived");

          await consensus.advanceTimeBySlots(fastLaneLengthSlots - 1n);

          expect((await consensus.getConsensusStateForMember(fastLaneMembers[2].getAddress())).canReport).to.be.true;
          await expect(
            consensus.connect(fastLaneMembers[2]).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION),
          ).to.emit(consensus, "ReportReceived");

          expect((await consensus.getConsensusState()).consensusReport).to.equal(HASH_1);
        });

        it(`non-fast lane members cannot submit a report in the first part of the frame`, async () => {
          for (const member of preparedFrameData.restMembers) {
            expect((await consensus.getConsensusStateForMember(member)).canReport).to.be.false;
            await expect(
              consensus.connect(member).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION),
            ).to.be.revertedWithCustomError(consensus, "NonFastLaneMemberCannotReportWithinFastLaneInterval()");
          }
        });

        it(`non-fast lane members can submit a report during the rest of the frame`, async () => {
          await consensus.advanceTimeBySlots(1);
          for (const member of preparedFrameData.restMembers) {
            expect((await consensus.getConsensusStateForMember(member)).canReport).to.be.true;
            await expect(consensus.connect(member).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION)).not.to.be
              .reverted;
          }

          const { variants, support } = await consensus.getReportVariants();
          expect([...variants]).to.have.members([HASH_1]);
          expect([...support]).to.have.members([5n]);
        });
      });
    });
    const testAllInFastLane = ({ quorumSize }: { quorumSize: bigint }) => {
      before(async () => {
        await deploy({ fastLaneLengthSlots: 10n });

        await consensus.addMember(member1, quorumSize, { from: admin });
        await consensus.addMember(member2, quorumSize, { from: admin });
        await consensus.addMember(member3, quorumSize, { from: admin });
      });

      before(setTimeToFrame0);

      const testFrame = (frameIndex: number) => {
        context(`Frame ${frameIndex}`, () => {
          after(async () => {
            await consensus.advanceTimeToNextFrameStart();
          });

          it(`all members are in the fast lane set`, async () => {
            expect(await consensus.getIsFastLaneMember(await member1.getAddress())).to.be.true;
            expect((await consensus.getConsensusStateForMember(await member1.getAddress())).isFastLane).to.be.true;

            expect(await consensus.getIsFastLaneMember(await member2.getAddress())).to.be.true;
            expect((await consensus.getConsensusStateForMember(await member2.getAddress())).isFastLane).to.be.true;

            expect(await consensus.getIsFastLaneMember(await member3.getAddress())).to.be.true;
            expect((await consensus.getConsensusStateForMember(await member3.getAddress())).isFastLane).to.be.true;

            const fastLaneMembers = (await consensus.getFastLaneMembers()).addresses;
            expect([...fastLaneMembers]).to.have.members([
              await member1.getAddress(),
              await member2.getAddress(),
              await member3.getAddress(),
            ]);

            const allMembers = (await consensus.getMembers()).addresses;
            expect([...allMembers]).to.have.members([
              await member1.getAddress(),
              await member2.getAddress(),
              await member3.getAddress(),
            ]);
          });

          it("non-members are not in the fast lane set", async () => {
            expect(await consensus.getIsFastLaneMember(stranger.getAddress())).to.be.false;
            expect((await consensus.getConsensusStateForMember(stranger.getAddress())).isFastLane).to.be.false;
          });
        });
      };

      Array.from({ length: 10 }, (_, i) => i).forEach(testFrame);
    };

    context("Quorum size equal to total members", () => testAllInFastLane({ quorumSize: 3n }));
    context("Quorum size more than total members", () => testAllInFastLane({ quorumSize: 5n }));
    context("Quorum is a max value", () => testAllInFastLane({ quorumSize: MAX_UINT256 }));
  });
});
