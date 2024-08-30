import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BaseOracle__Harness, ConsensusContract__Mock } from "typechain-types";

import {
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_EPOCH,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  SECONDS_PER_SLOT,
} from "lib";

import { deployBaseOracle, HASH_1, SECONDS_PER_EPOCH, SLOTS_PER_FRAME } from "test/deploy";
import { Snapshot } from "test/suite";

describe("BaseOracle.sol:accessControl", () => {
  let admin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let oracle: BaseOracle__Harness;
  let consensus: ConsensusContract__Mock;
  let originalState: string;

  before(async () => {
    [admin, stranger, manager] = await ethers.getSigners();

    const deployed = await deployBaseOracle(admin);
    oracle = deployed.oracle;
    consensus = deployed.consensusContract;
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  // FIXME: why in the ACL tests?
  context("constructor", () => {
    it("Reverts when slotsPerSecond is zero", async () => {
      await expect(deployBaseOracle(admin, { secondsPerSlot: 0n })).to.be.revertedWithCustomError(
        oracle,
        "SecondsPerSlotCannotBeZero",
      );
    });
  });

  context("setConsensusContract", () => {
    it("Reverts if the caller is unauthorized", async () => {
      const role = await oracle.MANAGE_CONSENSUS_CONTRACT_ROLE();
      await expect(oracle.setConsensusContract(stranger)).to.be.revertedWithOZAccessControlError(admin.address, role);

      expect(await oracle.getConsensusContract()).to.equal(await consensus.getAddress());
    });

    it("Updates consensus contract with MANAGE_CONSENSUS_CONTRACT_ROLE", async () => {
      const newConsensusContract = await ethers.deployContract("ConsensusContract__Mock", [
        SECONDS_PER_EPOCH,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        EPOCHS_PER_FRAME,
        INITIAL_EPOCH,
        INITIAL_FAST_LANE_LENGTH_SLOTS,
        admin,
      ]);

      const role = await oracle.MANAGE_CONSENSUS_CONTRACT_ROLE();

      await oracle.grantRole(role, manager);
      await oracle.connect(manager).setConsensusContract(await newConsensusContract.getAddress());

      expect(await oracle.getConsensusContract()).to.equal(await newConsensusContract.getAddress());
    });
  });

  context("setConsensusVersion", () => {
    it("Reverts if the caller is unauthorized", async () => {
      const role = await oracle.MANAGE_CONSENSUS_VERSION_ROLE();

      await expect(oracle.connect(stranger).setConsensusVersion(1)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        role,
      );

      expect(await oracle.getConsensusVersion()).to.equal(CONSENSUS_VERSION);
    });

    it("Updates consensus version with MANAGE_CONSENSUS_VERSION_ROLE", async () => {
      const role = await oracle.MANAGE_CONSENSUS_VERSION_ROLE();

      await oracle.grantRole(role, manager);
      await oracle.connect(manager).setConsensusVersion(2);

      expect(await oracle.getConsensusVersion()).to.equal(2);
    });
  });

  context("submitConsensusReport", () => {
    let initialRefSlot: bigint;

    before(async () => {
      initialRefSlot = await oracle.getTime();
    });

    it("Reverts if sender is not a consensus contract", async () => {
      await expect(
        oracle.connect(stranger).submitConsensusReport(HASH_1, initialRefSlot, initialRefSlot),
      ).to.be.revertedWithCustomError(oracle, "SenderIsNotTheConsensusContract");

      expect((await oracle.getConsensusReportLastCall()).callCount).to.equal(0);
    });

    it("Submits report from a consensus contract", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, initialRefSlot + SLOTS_PER_FRAME);

      expect((await oracle.getConsensusReportLastCall()).callCount).to.equal(1);
    });
  });

  context("discardConsensusReport", () => {
    let initialRefSlot: bigint;

    before(async () => {
      initialRefSlot = await oracle.getTime();
    });

    it("Reverts if sender is not a consensus contract", async () => {
      await expect(oracle.discardConsensusReport(initialRefSlot)).to.be.revertedWithCustomError(
        oracle,
        "SenderIsNotTheConsensusContract",
      );
    });

    it("Discards report from a consensus contract", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, initialRefSlot + SLOTS_PER_FRAME);

      expect((await oracle.getConsensusReportLastCall()).callCount).to.equal(1);

      await consensus.discardReportAsConsensus(initialRefSlot);
    });
  });
});
