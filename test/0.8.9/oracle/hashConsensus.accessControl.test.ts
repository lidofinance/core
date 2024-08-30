import { expect } from "chai";
import { MaxUint256, Signer } from "ethers";
import { ethers } from "hardhat";

import { HashConsensus, ReportProcessor__Mock } from "typechain-types";

import { CONSENSUS_VERSION, DEFAULT_ADMIN_ROLE, EPOCHS_PER_FRAME, streccak } from "lib";

import { deployHashConsensus, DeployHashConsensusParams } from "test/deploy";
import { Snapshot } from "test/suite";

describe("HashConsensus.sol:accessControl", function () {
  let consensus: HashConsensus;
  let reportProcessor: ReportProcessor__Mock;
  let reportProcessor2: ReportProcessor__Mock;

  let baseSnapshot: string;
  let snapshot: string;

  const manageMembersAndQuorumRoleKeccak256 = streccak("MANAGE_MEMBERS_AND_QUORUM_ROLE");
  const disableConsensusRoleKeccak256 = streccak("DISABLE_CONSENSUS_ROLE");
  const manageFrameConfigRoleKeccak256 = streccak("MANAGE_FRAME_CONFIG_ROLE");
  const manageReportProcessorRoleKeccak256 = streccak("MANAGE_REPORT_PROCESSOR_ROLE");
  const manageFastLineConfigRoleKeccak256 = streccak("MANAGE_FAST_LANE_CONFIG_ROLE");

  let admin: Signer;
  let account1: Signer;
  let account2: Signer;
  let member1: Signer;
  let member2: Signer;

  const deploy = async (options: DeployHashConsensusParams | undefined) => {
    if (baseSnapshot) {
      baseSnapshot = await Snapshot.refresh(baseSnapshot);
    } else {
      baseSnapshot = await Snapshot.take();
    }

    [admin, account1, account2, member1, member2] = await ethers.getSigners();
    const deployed = await deployHashConsensus(await admin.getAddress(), options);
    consensus = deployed.consensus;
    reportProcessor = deployed.reportProcessor;

    reportProcessor2 = await ethers.deployContract("ReportProcessor__Mock", [CONSENSUS_VERSION], admin);

    snapshot = await Snapshot.take();
  };

  const refresh = async () => {
    snapshot = await Snapshot.refresh(snapshot);
  };

  context("DEFAULT_ADMIN_ROLE", () => {
    before(async () => {
      await deploy({ initialEpoch: null });
    });

    beforeEach(refresh);

    context("updateInitialEpoch", () => {
      it("reverts when called without DEFAULT_ADMIN_ROLE", async () => {
        await expect(consensus.connect(account1).updateInitialEpoch(10)).to.be.revertedWithOZAccessControlError(
          await account1.getAddress(),
          DEFAULT_ADMIN_ROLE,
        );
        await consensus.connect(admin).grantRole(manageFrameConfigRoleKeccak256, await account2.getAddress());
        await expect(consensus.connect(account2).updateInitialEpoch(10)).to.be.revertedWithOZAccessControlError(
          await account2.getAddress(),
          DEFAULT_ADMIN_ROLE,
        );
      });

      it("allows calling from a possessor of DEFAULT_ADMIN_ROLE role", async () => {
        await consensus.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, await account2.getAddress());
        await consensus.connect(account2).updateInitialEpoch(10);
        expect((await consensus.getFrameConfig()).initialEpoch).to.equal(10);
      });
    });
  });

  context("AccessControl roles", () => {
    before(async () => {
      await deploy({});
    });

    beforeEach(refresh);

    context("deploying", () => {
      it("deploying hash consensus", async () => {
        expect(consensus).to.be.not.undefined;
        expect(reportProcessor).to.be.not.undefined;
      });
    });

    context("MANAGE_MEMBERS_AND_QUORUM_ROLE", () => {
      context("addMember", function () {
        it("should revert without MANAGE_MEMBERS_AND_QUORUM_ROLE role", async () => {
          await expect(
            consensus.connect(account1).addMember(await member1.getAddress(), 2),
          ).to.be.revertedWithOZAccessControlError(await account1.getAddress(), manageMembersAndQuorumRoleKeccak256);

          expect(await consensus.getIsMember(await member1.getAddress())).to.be.false;
          expect(await consensus.getQuorum()).to.equal(0);
        });

        it("should allow calling from a possessor of MANAGE_MEMBERS_AND_QUORUM_ROLE role", async () => {
          await consensus.connect(admin).grantRole(manageMembersAndQuorumRoleKeccak256, await account2.getAddress());
          await consensus.connect(account2).addMember(await member2.getAddress(), 1);
          expect(await consensus.getIsMember(await member2.getAddress())).to.be.true;
          expect(await consensus.getQuorum()).to.equal(1);
        });
      });

      context("removeMember", function () {
        it("should revert without MANAGE_MEMBERS_AND_QUORUM_ROLE role", async () => {
          await expect(
            consensus.connect(account1).removeMember(await member1.getAddress(), 2),
          ).to.be.revertedWithOZAccessControlError(await account1.getAddress(), manageMembersAndQuorumRoleKeccak256);
          expect(await consensus.getIsMember(await member1.getAddress())).to.be.false;
          expect(await consensus.getQuorum()).to.equal(0);
        });

        it("should allow calling from a possessor of MANAGE_MEMBERS_AND_QUORUM_ROLE role", async () => {
          await consensus.connect(admin).grantRole(manageMembersAndQuorumRoleKeccak256, await account2.getAddress());
          await consensus.connect(account2).addMember(await member2.getAddress(), 2);
          expect(await consensus.getIsMember(await member2.getAddress())).to.be.true;
          expect(await consensus.getQuorum()).to.equal(2);

          await consensus.connect(account2).removeMember(await member2.getAddress(), 1);
          expect(await consensus.getIsMember(await member2.getAddress())).to.be.false;
          expect(await consensus.getQuorum()).to.equal(1);
        });
      });

      context("setQuorum", () => {
        it("should revert without MANAGE_MEMBERS_AND_QUORUM_ROLE role", async () => {
          await expect(consensus.connect(account1).setQuorum(1)).to.be.revertedWithOZAccessControlError(
            await account1.getAddress(),
            manageMembersAndQuorumRoleKeccak256,
          );
          expect(await consensus.getQuorum()).to.equal(0);
        });

        it("should allow calling from a possessor of MANAGE_MEMBERS_AND_QUORUM_ROLE role", async () => {
          await consensus.connect(admin).grantRole(manageMembersAndQuorumRoleKeccak256, await account2.getAddress());
          await consensus.connect(account2).setQuorum(1);
          expect(await consensus.getQuorum()).to.equal(1);
        });
      });

      context("disableConsensus", () => {
        it("should revert without DISABLE_CONSENSUS_ROLE role", async () => {
          await expect(consensus.connect(account1).disableConsensus()).to.be.revertedWithOZAccessControlError(
            await account1.getAddress(),
            disableConsensusRoleKeccak256,
          );
          expect(await consensus.getQuorum()).to.equal(0);
        });
      });
    });

    context("DISABLE_CONSENSUS_ROLE", () => {
      context("setQuorum", () => {
        it("should revert without DISABLE_CONSENSUS_ROLE role", async () => {
          await expect(consensus.connect(account1).setQuorum(MaxUint256)).to.be.revertedWithOZAccessControlError(
            await account1.getAddress(),
            disableConsensusRoleKeccak256,
          );
          expect(await consensus.getQuorum()).to.equal(0);
        });

        it("should allow calling from a possessor of DISABLE_CONSENSUS_ROLE role", async () => {
          await consensus.connect(admin).grantRole(disableConsensusRoleKeccak256, await account2.getAddress());
          await consensus.connect(account2).setQuorum(MaxUint256);
          expect(await consensus.getQuorum()).to.equal(MaxUint256);
        });
      });

      context("disableConsensus", () => {
        it("should revert without DISABLE_CONSENSUS_ROLE role", async () => {
          await expect(consensus.connect(account1).disableConsensus()).to.be.revertedWithOZAccessControlError(
            await account1.getAddress(),
            disableConsensusRoleKeccak256,
          );
          expect(await consensus.getQuorum()).to.equal(0);
        });

        it("should allow calling from a possessor of DISABLE_CONSENSUS_ROLE role", async () => {
          await consensus.connect(admin).grantRole(disableConsensusRoleKeccak256, await account2.getAddress());
          await consensus.connect(account2).disableConsensus();
          expect(await consensus.getQuorum()).to.equal(MaxUint256);
        });
      });
    });

    context("MANAGE_FRAME_CONFIG_ROLE", () => {
      context("setFrameConfig", () => {
        it("should revert without MANAGE_FRAME_CONFIG_ROLE role", async () => {
          await expect(consensus.connect(account1).setFrameConfig(5, 0)).to.be.revertedWithOZAccessControlError(
            await account1.getAddress(),
            manageFrameConfigRoleKeccak256,
          );
          expect((await consensus.getFrameConfig()).epochsPerFrame).to.equal(EPOCHS_PER_FRAME);
        });

        it("should allow calling from a possessor of MANAGE_FRAME_CONFIG_ROLE role", async () => {
          await consensus.connect(admin).grantRole(manageFrameConfigRoleKeccak256, await account2.getAddress());
          await consensus.connect(account2).setFrameConfig(5, 0);
          expect((await consensus.getFrameConfig()).epochsPerFrame).to.equal(5);
        });
      });
    });

    context("MANAGE_REPORT_PROCESSOR_ROLE", () => {
      context("setReportProcessor", () => {
        it("should revert without MANAGE_REPORT_PROCESSOR_ROLE role", async () => {
          await expect(
            consensus.connect(account1).setReportProcessor(await reportProcessor2.getAddress()),
          ).to.be.revertedWithOZAccessControlError(await account1.getAddress(), manageReportProcessorRoleKeccak256);
        });

        it("should allow calling from a possessor of MANAGE_REPORT_PROCESSOR_ROLE role", async () => {
          await consensus.connect(admin).grantRole(manageReportProcessorRoleKeccak256, await account2.getAddress());
          await consensus.connect(account2).setReportProcessor(await reportProcessor2.getAddress());
          expect(await consensus.getReportProcessor()).to.equal(await reportProcessor2.getAddress());
        });
      });
    });

    context("MANAGE_FAST_LANE_CONFIG_ROLE", () => {
      context("setFastLaneLengthSlots", () => {
        it("should revert without MANAGE_FAST_LANE_CONFIG_ROLE role", async () => {
          await expect(consensus.connect(account1).setFastLaneLengthSlots(5)).to.be.revertedWithOZAccessControlError(
            await account1.getAddress(),
            manageFastLineConfigRoleKeccak256,
          );
        });

        it("should allow calling from a possessor of MANAGE_FAST_LANE_CONFIG_ROLE role", async () => {
          await consensus.connect(admin).grantRole(manageFastLineConfigRoleKeccak256, await account2.getAddress());
          await consensus.connect(account2).setFastLaneLengthSlots(64);
          expect((await consensus.getFrameConfig()).fastLaneLengthSlots).to.equal(64);
        });
      });
    });
  });
});
