import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BaseOracle__Harness, ConsensusContract__Mock } from "typechain-types";

import { CONSENSUS_VERSION, EPOCHS_PER_FRAME, GENESIS_TIME, SECONDS_PER_SLOT, SLOTS_PER_EPOCH } from "lib";

import { deadlineFromRefSlot, deployBaseOracle, epochFirstSlotAt, HASH_1, HASH_2 } from "test/deploy";
import { Snapshot } from "test/suite";

describe("BaseOracle.sol:consensus", () => {
  let admin: HardhatEthersSigner;
  let member: HardhatEthersSigner;
  let notMember: HardhatEthersSigner;
  let consensus: ConsensusContract__Mock;
  let originalState: string;
  let baseOracle: BaseOracle__Harness;
  let initialRefSlot: bigint;

  before(async () => {
    [admin, member, notMember] = await ethers.getSigners();

    const deployed = await deployBaseOracle(admin, {
      initialEpoch: 1n,
      mockMember: member,
    });

    consensus = deployed.consensusContract;
    baseOracle = deployed.oracle;

    await baseOracle.grantRole(await baseOracle.MANAGE_CONSENSUS_CONTRACT_ROLE(), admin);
    await baseOracle.grantRole(await baseOracle.MANAGE_CONSENSUS_VERSION_ROLE(), admin);

    const time = await baseOracle.getTime();
    initialRefSlot = epochFirstSlotAt(time);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("setConsensusContract", () => {
    context("Reverts", () => {
      it("on zero address", async () => {
        await expect(baseOracle.setConsensusContract(ZeroAddress)).to.be.revertedWithCustomError(
          baseOracle,
          "AddressCannotBeZero",
        );
      });

      it("on same contract", async () => {
        await expect(baseOracle.setConsensusContract(await consensus.getAddress())).to.be.revertedWithCustomError(
          baseOracle,
          "AddressCannotBeSame",
        );
      });

      it("on invalid contract", async () => {
        await expect(baseOracle.setConsensusContract(member.address)).to.be.revertedWithoutReason();
      });

      it("on mismatched config", async () => {
        const wrongConsensusContract = await ethers.deployContract("ConsensusContract__Mock", [
          SLOTS_PER_EPOCH,
          SECONDS_PER_SLOT + 1n,
          GENESIS_TIME + 1n,
          EPOCHS_PER_FRAME,
          1,
          0,
          admin.address,
        ]);

        const wrongConsensusContractAddress = await wrongConsensusContract.getAddress();

        await expect(baseOracle.setConsensusContract(wrongConsensusContractAddress)).to.be.revertedWithCustomError(
          baseOracle,
          "UnexpectedChainConfig",
        );
      });

      it("on consensus initial ref slot behind currently processing", async () => {
        const processingRefSlot = 100;

        await consensus.submitReportAsConsensus(HASH_1, processingRefSlot, Number(await baseOracle.getTime()) + 1);
        await baseOracle.startProcessing();

        const wrongConsensusContract = await ethers.deployContract("ConsensusContract__Mock", [
          SLOTS_PER_EPOCH,
          SECONDS_PER_SLOT,
          GENESIS_TIME,
          EPOCHS_PER_FRAME,
          1,
          0,
          admin.address,
        ]);

        await wrongConsensusContract.setInitialRefSlot(processingRefSlot - 1);

        await expect(baseOracle.setConsensusContract(await wrongConsensusContract.getAddress()))
          .to.be.revertedWithCustomError(baseOracle, "InitialRefSlotCannotBeLessThanProcessingOne")
          .withArgs(processingRefSlot - 1, processingRefSlot);
      });
    });

    it("Updates consensus contract", async () => {
      const newConsensusContract = await ethers.deployContract("ConsensusContract__Mock", [
        SLOTS_PER_EPOCH,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        EPOCHS_PER_FRAME,
        1,
        0,
        admin.address,
      ]);

      const newConsensusContractAddress = await newConsensusContract.getAddress();

      await newConsensusContract.setInitialRefSlot(initialRefSlot);

      await expect(baseOracle.setConsensusContract(newConsensusContractAddress))
        .to.emit(baseOracle, "ConsensusHashContractSet")
        .withArgs(await newConsensusContract.getAddress(), await consensus.getAddress());

      expect(await baseOracle.getConsensusContract()).to.equal(await newConsensusContract.getAddress());
    });
  });

  context("setConsensusVersion", () => {
    it("Reverts on same version", async () => {
      await expect(baseOracle.setConsensusVersion(CONSENSUS_VERSION)).to.be.revertedWithCustomError(
        baseOracle,
        "VersionCannotBeSame",
      );
    });

    it("Updates consensus version", async () => {
      await expect(baseOracle.setConsensusVersion(2))
        .to.emit(baseOracle, "ConsensusVersionSet")
        .withArgs(2, CONSENSUS_VERSION);

      const versionInState = await baseOracle.getConsensusVersion();

      expect(versionInState).to.equal(2);
    });
  });

  context("checkConsensusData", () => {
    let deadline: bigint;

    before(async () => {
      deadline = deadlineFromRefSlot(initialRefSlot);
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadline);
    });

    context("Reverts", async () => {
      it("on mismatched slot", async () => {
        const badSlot = initialRefSlot + 1n;

        await expect(baseOracle.checkConsensusData(badSlot, CONSENSUS_VERSION, HASH_1))
          .to.be.revertedWithCustomError(baseOracle, "UnexpectedRefSlot")
          .withArgs(initialRefSlot, badSlot);
      });

      it("on mismatched consensus version", async () => {
        const badVersion = CONSENSUS_VERSION + 1n;

        await expect(baseOracle.checkConsensusData(initialRefSlot, badVersion, HASH_1))
          .to.be.revertedWithCustomError(baseOracle, "UnexpectedConsensusVersion")
          .withArgs(CONSENSUS_VERSION, badVersion);
      });

      it("on mismatched hash", async () => {
        await expect(baseOracle.checkConsensusData(initialRefSlot, CONSENSUS_VERSION, HASH_2))
          .to.be.revertedWithCustomError(baseOracle, "UnexpectedDataHash")
          .withArgs(HASH_1, HASH_2);
      });
    });

    it("Checks correct data without errors", async () => {
      await expect(baseOracle.checkConsensusData(initialRefSlot, CONSENSUS_VERSION, HASH_1)).not.to.be.reverted;
    });
  });

  context("checkProcessingDeadline", () => {
    let deadline: bigint;

    before(async () => {
      deadline = deadlineFromRefSlot(initialRefSlot);
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadline);
    });

    it("Reverts if deadline is missed", async () => {
      await baseOracle.setTime(deadline + 10n);

      await expect(baseOracle.checkProcessingDeadline())
        .to.be.revertedWithCustomError(baseOracle, "ProcessingDeadlineMissed")
        .withArgs(deadline);
    });
  });

  context("isConsensusMember", () => {
    it("Returns false on non member", async () => {
      const r = await baseOracle.isConsensusMember(notMember);
      expect(r).to.be.false;
    });

    it("Returns true on member", async () => {
      const r = await baseOracle.isConsensusMember(member);
      expect(r).to.be.true;
    });
  });

  context("getCurrentRefSlot ", () => {
    it("Gets refSlot trough consensus contract", async () => {
      const oracleSlot = await baseOracle.getCurrentRefSlot();
      const { refSlot } = await consensus.getCurrentFrame();

      expect(oracleSlot).to.equal(refSlot);
    });
  });
});
