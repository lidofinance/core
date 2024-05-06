import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BaseOracleTimeTravellable, MockConsensusContract } from "typechain-types";

import { getCurrentBlockTimestamp, Snapshot } from "lib";

import {
  CONSENSUS_VERSION,
  deployBaseOracle,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  HASH_1,
  INITIAL_EPOCH,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  SECONDS_PER_EPOCH,
  SECONDS_PER_SLOT,
  SLOTS_PER_FRAME,
} from "./baseOracle";

describe("BaseOracle.sol", async () => {
  let admin: HardhatEthersSigner;
  let account1: HardhatEthersSigner;
  let account2: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let oracle: BaseOracleTimeTravellable;
  let consensus: MockConsensusContract;
  let originalState: string;

  before(async () => {
    [admin, account1, account2, member1] = await ethers.getSigners();
    await deploy();
  });

  const deploy = async (options = undefined) => {
    const deployed = await deployBaseOracle(admin, options);
    oracle = deployed.oracle;
    consensus = deployed.consensusContract;
  };

  const takeSnapshot = async () => {
    originalState = await Snapshot.take();
  };

  const rollback = async () => {
    await Snapshot.restore(originalState);
  };

  context("AccountingOracle deployment and initial configuration", () => {
    before(takeSnapshot);
    after(rollback);

    it("deploying oracle", async () => {
      expect(oracle).to.be.ok;
      expect(consensus).to.be.ok;
    });

    it("reverts when slotsPerSecond is zero", async () => {
      await expect(deployBaseOracle(admin, { secondsPerSlot: 0 })).to.be.revertedWithCustomError(
        oracle,
        "SecondsPerSlotCannotBeZero",
      );
    });

    it("test original getTime() function of the base oracle", async () => {
      const blockTime = await getCurrentBlockTimestamp();
      const time = await oracle.originalGetTime();
      expect(time).to.be.equal(blockTime);
    });
  });

  context("setConsensusContract", () => {
    beforeEach(takeSnapshot);
    afterEach(rollback);

    it("should revert without MANAGE_CONSENSUS_CONTRACT_ROLE role", async () => {
      const role = await oracle.MANAGE_CONSENSUS_CONTRACT_ROLE();
      await expect(oracle.setConsensusContract(member1)).to.be.revertedWithOZAccessControlError(admin.address, role);

      expect(await oracle.getConsensusContract()).to.be.equal(await consensus.getAddress());
    });

    it("should allow calling from a possessor of MANAGE_CONSENSUS_CONTRACT_ROLE role", async () => {
      const consensusContract2 = await ethers.deployContract("MockConsensusContract", [
        SECONDS_PER_EPOCH,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        EPOCHS_PER_FRAME,
        INITIAL_EPOCH,
        INITIAL_FAST_LANE_LENGTH_SLOTS,
        admin,
      ]);

      const role = await oracle.MANAGE_CONSENSUS_CONTRACT_ROLE();

      await oracle.grantRole(role, account2);
      await oracle.connect(account2).setConsensusContract(await consensusContract2.getAddress());
      expect(await oracle.getConsensusContract()).to.be.equal(await consensusContract2.getAddress());
    });
  });

  context("setConsensusVersion", () => {
    beforeEach(takeSnapshot);
    afterEach(rollback);

    it("should revert without MANAGE_CONSENSUS_VERSION_ROLE role", async () => {
      const role = await oracle.MANAGE_CONSENSUS_VERSION_ROLE();

      await expect(oracle.connect(account1).setConsensusVersion(1)).to.be.revertedWithOZAccessControlError(
        account1.address,
        role,
      );
      expect(await oracle.getConsensusVersion()).to.be.equal(CONSENSUS_VERSION);
    });

    it("should allow calling from a possessor of MANAGE_CONSENSUS_VERSION_ROLE role", async () => {
      const role = await oracle.MANAGE_CONSENSUS_VERSION_ROLE();
      await oracle.grantRole(role, account2);
      await oracle.connect(account2).setConsensusVersion(2);

      expect(await oracle.getConsensusVersion()).to.be.equal(2);
    });
  });

  context("submitConsensusReport", () => {
    let initialRefSlot: number;

    before(async () => {
      initialRefSlot = Number(await oracle.getTime());
    });

    beforeEach(takeSnapshot);
    afterEach(rollback);

    it("should revert from not a consensus contract", async () => {
      await expect(
        oracle.connect(account1).submitConsensusReport(HASH_1, initialRefSlot, initialRefSlot),
      ).to.be.revertedWithCustomError(oracle, "SenderIsNotTheConsensusContract");

      expect((await oracle.getConsensusReportLastCall()).callCount).to.be.equal(0);
    });

    it("should allow calling from a consensus contract", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, initialRefSlot + SLOTS_PER_FRAME);

      expect((await oracle.getConsensusReportLastCall()).callCount).to.be.equal(1);
    });

    it("should allow to discard report from a consensus contract", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, initialRefSlot + SLOTS_PER_FRAME);
      expect((await oracle.getConsensusReportLastCall()).callCount).to.be.equal(1);
      await consensus.discardReportAsConsensus(initialRefSlot);
    });

    it("should revert on discard from stranger", async () => {
      await expect(oracle.discardConsensusReport(initialRefSlot)).to.be.revertedWithCustomError(
        oracle,
        "SenderIsNotTheConsensusContract",
      );
    });
  });
});
