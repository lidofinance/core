import { expect } from "chai";
import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { StakingRouter_Mock, ValidatorExitVerifier, ValidatorsExitBusOracle_Mock } from "typechain-types";
import { ILidoLocator } from "typechain-types/test/0.8.9/contracts/oracle/OracleReportSanityCheckerMocks.sol";

import { updateBeaconBlockRoot } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import {
  encodeExitRequestsDataList,
  ExitRequest,
  findStakingRouterMockEvents,
  toHistoricalHeaderWitness,
  toProvableBeaconBlockHeader,
  toValidatorWitness,
} from "./validatorExitVerifierHelpers";
import { ACTIVE_VALIDATOR_PROOF } from "./validatorState";

describe("ValidatorExitVerifier.sol", () => {
  let originalState: string;

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  const FIRST_SUPPORTED_SLOT = 1;
  const PIVOT_SLOT = 2;
  const SLOTS_PER_EPOCH = 32;
  const SECONDS_PER_SLOT = 12;
  const GENESIS_TIME = 1606824000;
  const SHARD_COMMITTEE_PERIOD_IN_SECONDS = 8192;
  const LIDO_LOCATOR = "0x0000000000000000000000000000000000000001";

  describe("ValidatorExitVerifier Constructor", () => {
    const GI_FIRST_VALIDATOR_PREV = `0x${"1".repeat(64)}`;
    const GI_FIRST_VALIDATOR_CURR = `0x${"2".repeat(64)}`;
    const GI_HISTORICAL_SUMMARIES_PREV = `0x${"3".repeat(64)}`;
    const GI_HISTORICAL_SUMMARIES_CURR = `0x${"4".repeat(64)}`;

    let validatorExitVerifier: ValidatorExitVerifier;

    before(async () => {
      validatorExitVerifier = await ethers.deployContract("ValidatorExitVerifier", [
        LIDO_LOCATOR,
        GI_FIRST_VALIDATOR_PREV,
        GI_FIRST_VALIDATOR_CURR,
        GI_HISTORICAL_SUMMARIES_PREV,
        GI_HISTORICAL_SUMMARIES_CURR,
        FIRST_SUPPORTED_SLOT,
        PIVOT_SLOT,
        SLOTS_PER_EPOCH,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      ]);
    });

    it("sets all parameters correctly", async () => {
      expect(await validatorExitVerifier.LOCATOR()).to.equal(LIDO_LOCATOR);
      expect(await validatorExitVerifier.GI_FIRST_VALIDATOR_PREV()).to.equal(GI_FIRST_VALIDATOR_PREV);
      expect(await validatorExitVerifier.GI_FIRST_VALIDATOR_PREV()).to.equal(GI_FIRST_VALIDATOR_PREV);
      expect(await validatorExitVerifier.GI_FIRST_VALIDATOR_CURR()).to.equal(GI_FIRST_VALIDATOR_CURR);
      expect(await validatorExitVerifier.GI_HISTORICAL_SUMMARIES_PREV()).to.equal(GI_HISTORICAL_SUMMARIES_PREV);
      expect(await validatorExitVerifier.GI_HISTORICAL_SUMMARIES_CURR()).to.equal(GI_HISTORICAL_SUMMARIES_CURR);
      expect(await validatorExitVerifier.FIRST_SUPPORTED_SLOT()).to.equal(FIRST_SUPPORTED_SLOT);
      expect(await validatorExitVerifier.PIVOT_SLOT()).to.equal(PIVOT_SLOT);
      expect(await validatorExitVerifier.SLOTS_PER_EPOCH()).to.equal(SLOTS_PER_EPOCH);
      expect(await validatorExitVerifier.SECONDS_PER_SLOT()).to.equal(SECONDS_PER_SLOT);
      expect(await validatorExitVerifier.GENESIS_TIME()).to.equal(GENESIS_TIME);
      expect(await validatorExitVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS()).to.equal(
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      );
    });

    it("reverts with 'InvalidPivotSlot' if firstSupportedSlot > pivotSlot", async () => {
      await expect(
        ethers.deployContract("ValidatorExitVerifier", [
          LIDO_LOCATOR,
          GI_FIRST_VALIDATOR_PREV,
          GI_FIRST_VALIDATOR_CURR,
          GI_HISTORICAL_SUMMARIES_PREV,
          GI_HISTORICAL_SUMMARIES_CURR,
          200_000, // firstSupportedSlot
          100_000, // pivotSlot < firstSupportedSlot
          SLOTS_PER_EPOCH,
          SECONDS_PER_SLOT,
          GENESIS_TIME,
          SHARD_COMMITTEE_PERIOD_IN_SECONDS,
        ]),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "InvalidPivotSlot");
    });
  });

  describe("verifyActiveValidatorsAfterExitRequest method", () => {
    const GI_FIRST_VALIDATOR_INDEX = "0x0000000000000000000000000000000000000000000000000056000000000028";
    const GI_HISTORICAL_SUMMARIES_INDEX = "0x0000000000000000000000000000000000000000000000000000000000003b00";

    let validatorExitVerifier: ValidatorExitVerifier;

    let locator: ILidoLocator;
    let locatorAddr: string;

    let vebo: ValidatorsExitBusOracle_Mock;
    let veboAddr: string;

    let stakingRouter: StakingRouter_Mock;
    let stakingRouterAddr: string;

    before(async () => {
      vebo = await ethers.deployContract("ValidatorsExitBusOracle_Mock");
      veboAddr = await vebo.getAddress();

      stakingRouter = await ethers.deployContract("StakingRouter_Mock");
      stakingRouterAddr = await stakingRouter.getAddress();

      locator = await deployLidoLocator({ validatorsExitBusOracle: veboAddr, stakingRouter: stakingRouterAddr });
      locatorAddr = await locator.getAddress();

      validatorExitVerifier = await ethers.deployContract("ValidatorExitVerifier", [
        locatorAddr,
        GI_FIRST_VALIDATOR_INDEX,
        GI_FIRST_VALIDATOR_INDEX,
        GI_HISTORICAL_SUMMARIES_INDEX,
        GI_HISTORICAL_SUMMARIES_INDEX,
        FIRST_SUPPORTED_SLOT,
        PIVOT_SLOT,
        SLOTS_PER_EPOCH,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      ]);
    });

    it("accepts a valid proof and does not revert", async () => {
      const intervalInSlotsBetweenProvableBlockAndExitRequest = 1000;
      const veboExitRequestTimestamp =
        GENESIS_TIME +
        (ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot - intervalInSlotsBetweenProvableBlockAndExitRequest) *
          SECONDS_PER_SLOT;

      const moduleId = 1;
      const nodeOpId = 2;
      const exitRequests: ExitRequest[] = [
        {
          moduleId,
          nodeOpId,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          valPubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const encodedExitRequests = encodeExitRequestsDataList(exitRequests);
      const encodedExitRequestsHash = keccak256(encodedExitRequests);
      await vebo.setExitRequestsStatus(encodedExitRequestsHash, {
        totalItemsCount: 1n,
        deliveredItemsCount: 1n,
        reportDataFormat: 1n,
        contractVersion: 1n,
        deliveryHistory: [{ timestamp: veboExitRequestTimestamp, lastDeliveredKeyIndex: 1n }],
      });

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

      const tx = await validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
        encodedExitRequests,
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
      );

      const receipt = await tx.wait();
      const events = findStakingRouterMockEvents(receipt!, "UnexitedValidatorReported");
      expect(events.length).to.equal(1);

      const event = events[0];
      expect(event.args[0]).to.equal(moduleId);
      expect(event.args[1]).to.equal(nodeOpId);
      expect(event.args[2]).to.equal(ACTIVE_VALIDATOR_PROOF.validator.pubkey);
      expect(event.args[3]).to.equal(intervalInSlotsBetweenProvableBlockAndExitRequest * SECONDS_PER_SLOT);
    });

    it("accepts a valid historical proof and does not revert", async () => {
      const intervalInSlotsBetweenProvableBlockAndExitRequest = 1000;
      const veboExitRequestTimestamp =
        GENESIS_TIME +
        (ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot - intervalInSlotsBetweenProvableBlockAndExitRequest) *
          SECONDS_PER_SLOT;

      const moduleId = 1;
      const nodeOpId = 2;
      const exitRequests: ExitRequest[] = [
        {
          moduleId,
          nodeOpId,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          valPubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const encodedExitRequests = encodeExitRequestsDataList(exitRequests);
      const encodedExitRequestsHash = keccak256(encodedExitRequests);
      await vebo.setExitRequestsStatus(encodedExitRequestsHash, {
        totalItemsCount: 1n,
        deliveredItemsCount: 1n,
        reportDataFormat: 1n,
        contractVersion: 1n,
        deliveryHistory: [{ timestamp: veboExitRequestTimestamp, lastDeliveredKeyIndex: 1n }],
      });

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      const tx = await validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
        encodedExitRequests,
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, blockRootTimestamp),
        toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
      );

      const receipt = await tx.wait();
      const events = findStakingRouterMockEvents(receipt!, "UnexitedValidatorReported");
      expect(events.length).to.equal(1);

      const event = events[0];
      expect(event.args[0]).to.equal(moduleId);
      expect(event.args[1]).to.equal(nodeOpId);
      expect(event.args[2]).to.equal(ACTIVE_VALIDATOR_PROOF.validator.pubkey);
      expect(event.args[3]).to.equal(intervalInSlotsBetweenProvableBlockAndExitRequest * SECONDS_PER_SLOT);
    });

    it("reverts with 'UnsupportedSlot' when slot < FIRST_SUPPORTED_SLOT", async () => {
      // Use a slot smaller than FIRST_SUPPORTED_SLOT
      const invalidHeader = {
        ...ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
        slot: 0,
      };

      await expect(
        validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
          "0x",
          {
            rootsTimestamp: 1n,
            header: invalidHeader,
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        ),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "UnsupportedSlot");
    });

    it("reverts with 'RootNotFound' if the staticcall to the block roots contract fails/returns empty", async () => {
      const badTimestamp = 999_999_999;
      await expect(
        validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
          "0x",
          {
            rootsTimestamp: badTimestamp,
            header: ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        ),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "RootNotFound");
    });

    it("reverts with 'InvalidBlockHeader' if the block root from contract doesn't match the header root", async () => {
      const bogusBlockRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
      const mismatchTimestamp = await updateBeaconBlockRoot(bogusBlockRoot);

      await expect(
        validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
          "0x",
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, mismatchTimestamp),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        ),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "InvalidBlockHeader");
    });

    it("reverts if the validator proof is incorrect", async () => {
      const intervalInSecondsBetweenProvableBlockAndExitRequest = 1000;
      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);
      const veboExitRequestTimestamp = blockRootTimestamp - intervalInSecondsBetweenProvableBlockAndExitRequest;

      const moduleId = 1;
      const nodeOpId = 2;
      const exitRequests: ExitRequest[] = [
        {
          moduleId,
          nodeOpId,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          valPubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const encodedExitRequests = encodeExitRequestsDataList(exitRequests);
      const encodedExitRequestsHash = keccak256(encodedExitRequests);
      await vebo.setExitRequestsStatus(encodedExitRequestsHash, {
        totalItemsCount: 1n,
        deliveredItemsCount: 1n,
        reportDataFormat: 1n,
        contractVersion: 1n,
        deliveryHistory: [{ timestamp: veboExitRequestTimestamp, lastDeliveredKeyIndex: 1n }],
      });

      const timestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

      // Mutate one proof entry to break it
      const badWitness = {
        exitRequestIndex: 0n,
        ...ACTIVE_VALIDATOR_PROOF.validator,
        validatorProof: [
          ...ACTIVE_VALIDATOR_PROOF.validatorProof.slice(0, -1),
          "0xbadbadbad0000000000000000000000000000000000000000000000000000000", // corrupt last entry
        ],
      };

      await expect(
        validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
          encodedExitRequests,
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, timestamp),
          [badWitness],
        ),
      ).to.be.reverted;
    });

    it("reverts with 'UnsupportedSlot' if beaconBlock slot < FIRST_SUPPORTED_SLOT", async () => {
      const invalidHeader = {
        ...ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
        slot: 0,
      };

      await expect(
        validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
          "0x",
          {
            rootsTimestamp: 1n,
            header: invalidHeader,
          },
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        ),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "UnsupportedSlot");
    });

    it("reverts with 'UnsupportedSlot' if oldBlock slot < FIRST_SUPPORTED_SLOT", async () => {
      const invalidHeader = {
        ...ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
        slot: 0,
      };

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await expect(
        validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
          "0x",
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, blockRootTimestamp),
          {
            header: invalidHeader,
            rootGIndex: ACTIVE_VALIDATOR_PROOF.historicalSummariesGI,
            proof: ACTIVE_VALIDATOR_PROOF.historicalRootProof,
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        ),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "UnsupportedSlot");
    });

    it("reverts with 'RootNotFound' if block root contract call fails", async () => {
      const badTimestamp = 999_999_999;
      await expect(
        validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
          "0x",
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, badTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        ),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "RootNotFound");
    });

    it("reverts with 'InvalidBlockHeader' if returned root doesn't match the new block header root", async () => {
      const bogusBlockRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
      const mismatchTimestamp = await updateBeaconBlockRoot(bogusBlockRoot);

      await expect(
        validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
          "0x",
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, mismatchTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        ),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "InvalidBlockHeader");
    });

    it("reverts with 'InvalidGIndex' if oldBlock.rootGIndex is not under the historicalSummaries root", async () => {
      // Provide an obviously wrong rootGIndex that won't match the parent's
      const invalidRootGIndex = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

      const timestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await expect(
        validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
          "0x",
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, timestamp),
          {
            header: ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
            proof: ACTIVE_VALIDATOR_PROOF.historicalRootProof,
            rootGIndex: invalidRootGIndex,
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 1)],
        ),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "InvalidGIndex");
    });

    it("reverts if the oldBlock proof is corrupted", async () => {
      const timestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await expect(
        validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
          "0x",
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, timestamp),
          {
            header: ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
            rootGIndex: ACTIVE_VALIDATOR_PROOF.historicalSummariesGI,
            // Mutate one proof entry to break the historical block proof
            proof: [
              ...ACTIVE_VALIDATOR_PROOF.historicalRootProof.slice(0, -1),
              "0xbadbadbad0000000000000000000000000000000000000000000000000000000",
            ],
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 1)],
        ),
      ).to.be.reverted;
    });

    it("reverts if the validatorProof in the witness is corrupted", async () => {
      const intervalInSecondsBetweenProvableBlockAndExitRequest = 1000;
      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);
      const veboExitRequestTimestamp = blockRootTimestamp - intervalInSecondsBetweenProvableBlockAndExitRequest;

      const moduleId = 1;
      const nodeOpId = 2;
      const exitRequests: ExitRequest[] = [
        {
          moduleId,
          nodeOpId,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          valPubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const encodedExitRequests = encodeExitRequestsDataList(exitRequests);
      const encodedExitRequestsHash = keccak256(encodedExitRequests);
      await vebo.setExitRequestsStatus(encodedExitRequestsHash, {
        totalItemsCount: 1n,
        deliveredItemsCount: 1n,
        reportDataFormat: 1n,
        contractVersion: 1n,
        deliveryHistory: [{ timestamp: veboExitRequestTimestamp, lastDeliveredKeyIndex: 1n }],
      });

      const timestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      // Mutate one proof entry to break it
      const badWitness = {
        exitRequestIndex: 0n,
        ...ACTIVE_VALIDATOR_PROOF.validator,
        validatorProof: [
          ...ACTIVE_VALIDATOR_PROOF.validatorProof.slice(0, -1),
          "0xbadbadbad0000000000000000000000000000000000000000000000000000000", // corrupt last entry
        ],
      };

      await expect(
        validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
          encodedExitRequests,
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, timestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [badWitness],
        ),
      ).to.be.reverted;
    });
  });
});
