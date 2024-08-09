import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForLegacyOracle,
  HashConsensus__MockForLegacyOracle,
  LegacyOracle__Harness,
  LidoLocator,
} from "typechain-types";

import {
  certainAddress,
  EPOCHS_PER_FRAME,
  ether,
  GENESIS_TIME,
  getCurrentBlockTimestamp,
  impersonate,
  INITIAL_EPOCH,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  proxify,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib";

import { deployLidoLocator, timestampAtEpoch, timestampAtSlot, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

describe("LegacyOracle.sol", () => {
  let admin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let legacyOracle: LegacyOracle__Harness;

  let locator: LidoLocator;
  let consensusContract: HashConsensus__MockForLegacyOracle;
  let accountingOracle: AccountingOracle__MockForLegacyOracle;

  let lido: string;

  let originalState: string;

  before(async () => {
    [admin, stranger] = await ethers.getSigners();

    const impl = await ethers.deployContract("LegacyOracle__Harness");
    [legacyOracle] = await proxify({ impl, admin });

    lido = certainAddress("legacy-oracle:lido");

    consensusContract = await ethers.deployContract("HashConsensus__MockForLegacyOracle", [
      SLOTS_PER_EPOCH,
      SECONDS_PER_SLOT,
      GENESIS_TIME,
      INITIAL_EPOCH,
      EPOCHS_PER_FRAME,
      INITIAL_FAST_LANE_LENGTH_SLOTS,
    ]);

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForLegacyOracle", [
      lido,
      consensusContract,
      SECONDS_PER_SLOT,
    ]);

    locator = await deployLidoLocator({ legacyOracle, accountingOracle, lido });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getLido", () => {
    it("Returns lido address", async () => {
      await legacyOracle.initialize(locator, consensusContract);

      expect(await legacyOracle.getLido()).to.equal(lido);
    });
  });

  context("getAccountingOracle", () => {
    it("Returns accountingOracle address", async () => {
      await legacyOracle.initialize(locator, consensusContract);

      expect(await legacyOracle.getAccountingOracle()).to.equal(accountingOracle);
    });
  });

  context("getVersion", () => {
    it("Returns version", async () => {
      await legacyOracle.initialize(locator, consensusContract);

      expect(await legacyOracle.getVersion()).to.equal(4);
    });
  });

  context("getBeaconSpec", () => {
    it("Returns beacon spec", async () => {
      await legacyOracle.initialize(locator, consensusContract);

      const spec = await legacyOracle.getBeaconSpec();

      expect(spec.epochsPerFrame).to.equal(EPOCHS_PER_FRAME);
      expect(spec.slotsPerEpoch).to.equal(SLOTS_PER_EPOCH);
      expect(spec.secondsPerSlot).to.equal(SECONDS_PER_SLOT);
      expect(spec.genesisTime).to.equal(GENESIS_TIME);
    });
  });

  context("getCurrentEpochId", () => {
    beforeEach(async () => {
      await legacyOracle.initialize(locator, consensusContract);
    });

    it("Returns current epoch id", async () => {
      for (let index = 0; index < 20; index++) {
        const consensusTime = await consensusContract.getTime();
        const oracleEpochId = await legacyOracle.getCurrentEpochId();

        const consensusEpochId = (consensusTime - GENESIS_TIME) / (SLOTS_PER_EPOCH * SECONDS_PER_SLOT);

        expect(oracleEpochId).to.equal(consensusEpochId);

        await consensusContract.advanceTimeByEpochs(1);
      }
    });

    it("Returns current epoch id on the edge", async () => {
      const epochDuration = SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      const consensusTime = GENESIS_TIME + epochDuration;

      await consensusContract.setTime(consensusTime);

      const oracleEpochId = await legacyOracle.getCurrentEpochId();

      expect(oracleEpochId).to.equal(1);
    });
  });

  context("getCurrentFrame", () => {
    beforeEach(async () => {
      await legacyOracle.initialize(locator, consensusContract);
    });

    it("Returns frame synced with consensus contract", async () => {
      const consensusFrame = await consensusContract.getCurrentFrame();

      const frame = await legacyOracle.getCurrentFrame();

      expect(frame.frameEpochId).to.equal((consensusFrame.refSlot + 1n) / SLOTS_PER_EPOCH, "frameEpochId");
      expect(frame.frameStartTime).to.equal(timestampAtSlot(consensusFrame.refSlot + 1n), "frameStartTime");
      expect(frame.frameEndTime).to.equal(
        timestampAtEpoch(frame.frameEpochId + EPOCHS_PER_FRAME) - 1n,
        "frameEndTime",
      );
    });

    it("Returns frame synced with consensus contract on the edge", async () => {
      const frameDuration = EPOCHS_PER_FRAME * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      const consensusTime = GENESIS_TIME + frameDuration;

      await consensusContract.setTime(consensusTime);

      const frame = await legacyOracle.getCurrentFrame();

      const expectedFrameEpochId = 1n;
      const expectedFrameStartTime = timestampAtEpoch(expectedFrameEpochId);
      const expectedFrameEndTime = timestampAtEpoch(expectedFrameEpochId + EPOCHS_PER_FRAME) - 1n;

      expect(frame.frameEpochId).to.equal(expectedFrameEpochId, "frameEpochId");
      expect(frame.frameStartTime).to.equal(expectedFrameStartTime, "frameStartTime");
      expect(frame.frameEndTime).to.equal(expectedFrameEndTime, "frameEndTime");
    });
  });

  context("getLastCompletedEpochId", () => {
    it("Returns last completed epoch id", async () => {
      await legacyOracle.initialize(locator, consensusContract);

      expect(await legacyOracle.getLastCompletedEpochId()).to.equal(0);
    });
  });

  context("getLastCompletedReportDelta", () => {
    it("Returns last completed report delta", async () => {
      await legacyOracle.initialize(locator, consensusContract);

      const delta = await legacyOracle.getLastCompletedReportDelta();
      expect(delta.postTotalPooledEther).to.equal(0, "postTotalPooledEther");
      expect(delta.preTotalPooledEther).to.equal(0, "preTotalPooledEther");
      expect(delta.timeElapsed).to.equal(0, "timeElapsed");
    });
  });

  context("handlePostTokenRebase", () => {
    beforeEach(async () => {
      await legacyOracle.initialize(locator, consensusContract);
    });

    it("Reverts if called by non Lido", async () => {
      await expect(legacyOracle.connect(stranger).handlePostTokenRebase(1, 2, 3, 4, 5, 6, 7)).to.be.revertedWith(
        "SENDER_NOT_ALLOWED",
      );
    });

    it("Handles post token rebase report", async () => {
      const lidoActor = await impersonate(lido, ether("1000"));

      await expect(legacyOracle.connect(lidoActor).handlePostTokenRebase(1, 2, 3, 4, 5, 6, 7))
        .to.emit(legacyOracle, "PostTotalShares")
        .withArgs(6, 4, 2, 5);

      const delta = await legacyOracle.getLastCompletedReportDelta();
      expect(delta.postTotalPooledEther).to.equal(6, "postTotalPooledEther");
      expect(delta.preTotalPooledEther).to.equal(4, "preTotalPooledEther");
      expect(delta.timeElapsed).to.equal(2, "timeElapsed");
    });

    it("Emits PostTotalShares event with zero values when appropriate", async () => {
      const lidoActor = await impersonate(lido, ether("1000"));

      await expect(legacyOracle.connect(lidoActor).handlePostTokenRebase(0, 0, 0, 0, 0, 0, 0))
        .to.emit(legacyOracle, "PostTotalShares")
        .withArgs(0, 0, 0, 0);

      const delta = await legacyOracle.getLastCompletedReportDelta();
      expect(delta.postTotalPooledEther).to.equal(0, "postTotalPooledEther");
      expect(delta.preTotalPooledEther).to.equal(0, "preTotalPooledEther");
      expect(delta.timeElapsed).to.equal(0, "timeElapsed");
    });
  });

  context("handleConsensusLayerReport", () => {
    const refSlot = 3000n;

    beforeEach(async () => {
      await legacyOracle.initialize(locator, consensusContract);
    });

    it("Reverts if called by non Lido", async () => {
      await expect(legacyOracle.connect(stranger).handleConsensusLayerReport(refSlot, 2, 3)).to.be.revertedWith(
        "SENDER_NOT_ALLOWED",
      );
    });

    it("Handles consensus layer report", async () => {
      const accountingOracleAddress = await accountingOracle.getAddress();
      const accountingOracleActor = await impersonate(accountingOracleAddress, ether("1000"));

      const epochId = (refSlot + 1n) / SLOTS_PER_EPOCH;

      await expect(legacyOracle.connect(accountingOracleActor).handleConsensusLayerReport(refSlot, 2, 3))
        .to.emit(legacyOracle, "Completed")
        .withArgs(epochId, 2, 3);

      const lastCompletedEpochId = await legacyOracle.getLastCompletedEpochId();

      expect(lastCompletedEpochId).to.equal(epochId);
    });

    it("Emits Completed event with zero values when appropriate", async () => {
      const accountingOracleAddress = await accountingOracle.getAddress();
      const accountingOracleActor = await impersonate(accountingOracleAddress, ether("1000"));

      const baseRefSlot = 0n;
      const expectedEpochId = (baseRefSlot + 1n) / SLOTS_PER_EPOCH;

      await expect(legacyOracle.connect(accountingOracleActor).handleConsensusLayerReport(baseRefSlot, 0, 0))
        .to.emit(legacyOracle, "Completed")
        .withArgs(expectedEpochId, 0, 0);

      const lastCompletedEpochId = await legacyOracle.getLastCompletedEpochId();
      expect(lastCompletedEpochId).to.equal(expectedEpochId);
    });
  });

  context("initialize", () => {
    context("Reverts", () => {
      it("if locator is zero address", async () => {
        await expect(legacyOracle.initialize(ZeroAddress, ZeroAddress)).to.revertedWith("ZERO_LOCATOR_ADDRESS");
      });

      it("if accountingOracle is zero address", async () => {
        const brokenLocator = await deployLidoLocator({ legacyOracle, accountingOracle }, admin);

        const brokenLocatorAddress = await brokenLocator.getAddress();
        await updateLidoLocatorImplementation(
          brokenLocatorAddress,
          { accountingOracle },
          "LidoLocator__MutableMock",
          admin,
        );

        const locatorMutable = await ethers.getContractAt("LidoLocator__MutableMock", brokenLocatorAddress);
        await locatorMutable.mock___updateAccountingOracle(ZeroAddress);

        await expect(legacyOracle.initialize(locatorMutable, ZeroAddress)).to.revertedWith(
          "ZERO_ACCOUNTING_ORACLE_ADDRESS",
        );
      });

      it("if already initialized", async () => {
        await legacyOracle.initialize(locator, consensusContract);

        await expect(legacyOracle.initialize(locator, consensusContract)).to.be.revertedWith(
          "INIT_ALREADY_INITIALIZED",
        );
      });

      async function getSpoiledChainSpecMocks({
        slotsPerEpoch = SLOTS_PER_EPOCH,
        secondsPerSlot = SECONDS_PER_SLOT,
        genesisTime = GENESIS_TIME,
        initialEpoch = INITIAL_EPOCH,
        epochsPerFrame = EPOCHS_PER_FRAME,
        initialFastLaneLengthSlots = INITIAL_FAST_LANE_LENGTH_SLOTS,
      }) {
        const invalidConsensusContract = await ethers.deployContract("HashConsensus__MockForLegacyOracle", [
          slotsPerEpoch,
          secondsPerSlot,
          genesisTime,
          initialEpoch,
          epochsPerFrame,
          initialFastLaneLengthSlots,
        ]);

        const accountingOracleMock = await ethers.deployContract("AccountingOracle__MockForLegacyOracle", [
          lido,
          invalidConsensusContract,
          secondsPerSlot,
        ]);

        const locatorConfig = {
          lido,
          legacyOracle,
          accountingOracle: accountingOracleMock,
        };
        const invalidLocator = await deployLidoLocator(locatorConfig, admin);

        return { invalidLocator, invalidConsensusContract };
      }

      it("if chain spec SLOTS_PER_EPOCH is 0", async () => {
        const { invalidLocator, invalidConsensusContract } = await getSpoiledChainSpecMocks({
          slotsPerEpoch: 0n,
        });

        await expect(legacyOracle.initialize(invalidLocator, invalidConsensusContract)).to.be.revertedWith(
          "BAD_SLOTS_PER_EPOCH",
        );
      });

      it("if chain spec SECONDS_PER_SLOT is 0", async () => {
        const { invalidLocator, invalidConsensusContract } = await getSpoiledChainSpecMocks({
          secondsPerSlot: 0n,
        });

        await expect(legacyOracle.initialize(invalidLocator, invalidConsensusContract)).to.be.revertedWith(
          "BAD_SECONDS_PER_SLOT",
        );
      });

      it("if chain spec GENESIS_TIME is 0", async () => {
        const { invalidLocator, invalidConsensusContract } = await getSpoiledChainSpecMocks({
          genesisTime: 0n,
        });

        await expect(legacyOracle.initialize(invalidLocator, invalidConsensusContract)).to.be.revertedWith(
          "BAD_GENESIS_TIME",
        );
      });

      it("if chain spec EPOCHS_PER_FRAME is 0", async () => {
        const { invalidLocator, invalidConsensusContract } = await getSpoiledChainSpecMocks({
          epochsPerFrame: 0n,
        });

        await expect(legacyOracle.initialize(invalidLocator, invalidConsensusContract)).to.be.revertedWith(
          "BAD_EPOCHS_PER_FRAME",
        );
      });

      it("if wrong base version us used", async () => {
        await legacyOracle.harness__setContractDeprecatedVersion(3);

        await expect(legacyOracle.initialize(locator, consensusContract)).to.be.revertedWith("WRONG_BASE_VERSION");
      });
    });

    it("Initializes correctly", async () => {
      await legacyOracle.initialize(locator, consensusContract);

      expect(await legacyOracle.getVersion()).to.equal(4);
      expect(await legacyOracle.getAccountingOracle()).to.equal(accountingOracle);
      expect(await legacyOracle.getLido()).to.equal(lido);

      const spec = await legacyOracle.getBeaconSpec();

      expect(spec.epochsPerFrame).to.equal(EPOCHS_PER_FRAME);
      expect(spec.slotsPerEpoch).to.equal(SLOTS_PER_EPOCH);
      expect(spec.secondsPerSlot).to.equal(SECONDS_PER_SLOT);
      expect(spec.genesisTime).to.equal(GENESIS_TIME);

      expect(await legacyOracle.getLastCompletedEpochId()).to.equal(0);
    });
  });

  context("finalizeUpgrade_v4", () => {
    context("Reverts", () => {
      it("if not upgradeable", async () => {
        await legacyOracle.initialize(locator, consensusContract);

        await expect(legacyOracle.finalizeUpgrade_v4(accountingOracle)).to.be.revertedWith("WRONG_BASE_VERSION");
      });

      it("if chain is not set", async () => {
        await legacyOracle.harness__setContractDeprecatedVersion(3);

        await expect(legacyOracle.finalizeUpgrade_v4(accountingOracle)).to.be.revertedWith("UNEXPECTED_CHAIN_SPEC");
      });
    });

    it("Finalizes upgrade correctly", async () => {
      await legacyOracle.harness__setContractDeprecatedVersion(3);
      await legacyOracle.harness__updateChainSpec(consensusContract);

      await legacyOracle.finalizeUpgrade_v4(accountingOracle);

      expect(await legacyOracle.getVersion()).to.equal(4);
    });
  });

  // @dev just to have full coverage, because for testing purposes _getTime is overridden in the Harness contract
  context("_getTime", () => {
    it("Returns current time", async () => {
      await legacyOracle.initialize(locator, consensusContract);

      const time = await legacyOracle.harness__getTime();
      const blockTimestamp = await getCurrentBlockTimestamp();

      expect(time).to.equal(blockTimestamp);
    });
  });
});
