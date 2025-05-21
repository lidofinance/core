import { expect } from "chai";
import { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { StakingRouter_Mock, ValidatorExitDelayVerifier, ValidatorsExitBusOracle_Mock } from "typechain-types";
import { ILidoLocator } from "typechain-types/test/0.8.9/contracts/oracle/OracleReportSanityCheckerMocks.sol";

import { updateBeaconBlockRoot } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import {
  encodeExitRequestsDataListWithFormat,
  ExitRequest,
  findStakingRouterMockEvents,
  toHistoricalHeaderWitness,
  toProvableBeaconBlockHeader,
  toValidatorWitness,
} from "./validatorExitDelayVerifierHelpers";
import { ACTIVE_VALIDATOR_PROOF } from "./validatorState";

const EMPTY_REPORT = { data: "0x", dataFormat: 1n };

describe("ValidatorExitDelayVerifier.sol", () => {
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

  describe("ValidatorExitDelayVerifier Constructor", () => {
    const GI_FIRST_VALIDATOR_PREV = `0x${"1".repeat(64)}`;
    const GI_FIRST_VALIDATOR_CURR = `0x${"2".repeat(64)}`;
    const GI_HISTORICAL_SUMMARIES_PREV = `0x${"3".repeat(64)}`;
    const GI_HISTORICAL_SUMMARIES_CURR = `0x${"4".repeat(64)}`;

    let validatorExitDelayVerifier: ValidatorExitDelayVerifier;

    before(async () => {
      validatorExitDelayVerifier = await ethers.deployContract("ValidatorExitDelayVerifier", [
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
      expect(await validatorExitDelayVerifier.LOCATOR()).to.equal(LIDO_LOCATOR);
      expect(await validatorExitDelayVerifier.GI_FIRST_VALIDATOR_PREV()).to.equal(GI_FIRST_VALIDATOR_PREV);
      expect(await validatorExitDelayVerifier.GI_FIRST_VALIDATOR_PREV()).to.equal(GI_FIRST_VALIDATOR_PREV);
      expect(await validatorExitDelayVerifier.GI_FIRST_VALIDATOR_CURR()).to.equal(GI_FIRST_VALIDATOR_CURR);
      expect(await validatorExitDelayVerifier.GI_HISTORICAL_SUMMARIES_PREV()).to.equal(GI_HISTORICAL_SUMMARIES_PREV);
      expect(await validatorExitDelayVerifier.GI_HISTORICAL_SUMMARIES_CURR()).to.equal(GI_HISTORICAL_SUMMARIES_CURR);
      expect(await validatorExitDelayVerifier.FIRST_SUPPORTED_SLOT()).to.equal(FIRST_SUPPORTED_SLOT);
      expect(await validatorExitDelayVerifier.PIVOT_SLOT()).to.equal(PIVOT_SLOT);
      expect(await validatorExitDelayVerifier.SLOTS_PER_EPOCH()).to.equal(SLOTS_PER_EPOCH);
      expect(await validatorExitDelayVerifier.SECONDS_PER_SLOT()).to.equal(SECONDS_PER_SLOT);
      expect(await validatorExitDelayVerifier.GENESIS_TIME()).to.equal(GENESIS_TIME);
      expect(await validatorExitDelayVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS()).to.equal(
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      );
    });

    it("reverts with 'InvalidPivotSlot' if firstSupportedSlot > pivotSlot", async () => {
      await expect(
        ethers.deployContract("ValidatorExitDelayVerifier", [
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
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "InvalidPivotSlot");
    });

    it("reverts with 'ZeroLidoLocatorAddress' if lidoLocator is zero address", async () => {
      await expect(
        ethers.deployContract("ValidatorExitDelayVerifier", [
          ethers.ZeroAddress, // Zero address for locator
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
        ]),
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("ValidatorExitDelayVerifier"),
        "ZeroLidoLocatorAddress",
      );
    });
  });

  describe("verifyValidatorExitDelay method", () => {
    const GI_FIRST_VALIDATOR_INDEX = "0x0000000000000000000000000000000000000000000000000096000000000028";
    const GI_HISTORICAL_SUMMARIES_INDEX = "0x0000000000000000000000000000000000000000000000000000000000005b00";

    let validatorExitDelayVerifier: ValidatorExitDelayVerifier;

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

      validatorExitDelayVerifier = await ethers.deployContract("ValidatorExitDelayVerifier", [
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
      const proofSlotTimestamp = GENESIS_TIME + ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot * SECONDS_PER_SLOT;

      const exitRequests: ExitRequest[] = [
        {
          moduleId: 11,
          nodeOpId: 11,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
        {
          moduleId: 22,
          nodeOpId: 22,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

      await vebo.setExitRequests(
        encodedExitRequestsHash,
        [{ timestamp: veboExitRequestTimestamp, lastDeliveredKeyIndex: 1n }],
        exitRequests,
      );

      const verifyExitDelayEvents = async (tx: ContractTransactionResponse) => {
        const receipt = await tx.wait();
        const events = findStakingRouterMockEvents(receipt!, "UnexitedValidatorReported");
        expect(events.length).to.equal(2);

        const firstEvent = events[0];
        expect(firstEvent.args[0]).to.equal(11);
        expect(firstEvent.args[1]).to.equal(11);
        expect(firstEvent.args[2]).to.equal(proofSlotTimestamp);
        expect(firstEvent.args[3]).to.equal(ACTIVE_VALIDATOR_PROOF.validator.pubkey);
        expect(firstEvent.args[4]).to.equal(intervalInSlotsBetweenProvableBlockAndExitRequest * SECONDS_PER_SLOT);

        const secondEvent = events[1];
        expect(secondEvent.args[0]).to.equal(22);
        expect(secondEvent.args[1]).to.equal(22);
        expect(secondEvent.args[2]).to.equal(proofSlotTimestamp);
        expect(secondEvent.args[3]).to.equal(ACTIVE_VALIDATOR_PROOF.validator.pubkey);
        expect(secondEvent.args[4]).to.equal(intervalInSlotsBetweenProvableBlockAndExitRequest * SECONDS_PER_SLOT);
      };

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);
      const futureBlockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await verifyExitDelayEvents(
        await validatorExitDelayVerifier.verifyValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0), toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 1)],
          encodedExitRequests,
        ),
      );

      await verifyExitDelayEvents(
        await validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0), toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 1)],
          encodedExitRequests,
        ),
      );
    });

    it("reverts with 'UnsupportedSlot' when slot < FIRST_SUPPORTED_SLOT", async () => {
      // Use a slot smaller than FIRST_SUPPORTED_SLOT
      const invalidHeader = {
        ...ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
        slot: 0,
      };

      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          {
            rootsTimestamp: 1n,
            header: invalidHeader,
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          EMPTY_REPORT,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "UnsupportedSlot");

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          {
            rootsTimestamp: 1n,
            header: invalidHeader,
          },
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          EMPTY_REPORT,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "UnsupportedSlot");
    });

    it("reverts with 'UnsupportedSlot' if for historical proof the oldBlock slot < FIRST_SUPPORTED_SLOT", async () => {
      const invalidHeader = {
        ...ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
        slot: 0,
      };

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, blockRootTimestamp),
          {
            header: invalidHeader,
            rootGIndex: ACTIVE_VALIDATOR_PROOF.historicalSummariesGI,
            proof: ACTIVE_VALIDATOR_PROOF.historicalRootProof,
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          EMPTY_REPORT,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "UnsupportedSlot");
    });

    it("reverts with 'RootNotFound' if the staticcall to the block roots contract fails/returns empty", async () => {
      const badTimestamp = 999_999_999;
      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          {
            rootsTimestamp: badTimestamp,
            header: ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          EMPTY_REPORT,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "RootNotFound");

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          {
            rootsTimestamp: badTimestamp,
            header: ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
          },
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          EMPTY_REPORT,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "RootNotFound");
    });

    it("reverts with 'InvalidBlockHeader' if the block root from contract doesn't match the header root", async () => {
      const bogusBlockRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
      const mismatchTimestamp = await updateBeaconBlockRoot(bogusBlockRoot);

      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, mismatchTimestamp),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          EMPTY_REPORT,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "InvalidBlockHeader");

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, mismatchTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          EMPTY_REPORT,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "InvalidBlockHeader");
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
          pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

      await vebo.setExitRequests(
        encodedExitRequestsHash,
        [{ timestamp: veboExitRequestTimestamp, lastDeliveredKeyIndex: 1n }],
        exitRequests,
      );

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
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, timestamp),
          [badWitness],
          encodedExitRequests,
        ),
      ).to.be.reverted;

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, timestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [badWitness],
          encodedExitRequests,
        ),
      ).to.be.reverted;
    });

    it("reverts with 'InvalidGIndex' if oldBlock.rootGIndex is not under the historicalSummaries root", async () => {
      // Provide an obviously wrong rootGIndex that won't match the parent's
      const invalidRootGIndex = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

      const timestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, timestamp),
          {
            header: ACTIVE_VALIDATOR_PROOF.beaconBlockHeader,
            proof: ACTIVE_VALIDATOR_PROOF.historicalRootProof,
            rootGIndex: invalidRootGIndex,
          },
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 1)],
          EMPTY_REPORT,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "InvalidGIndex");
    });

    it("reverts with 'KeyWasNotUnpacked' if exit request index is not in delivery history", async () => {
      const nodeOpId = 2;
      const exitRequests: ExitRequest[] = [
        {
          moduleId: 1,
          nodeOpId,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
        {
          moduleId: 2,
          nodeOpId,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
        {
          moduleId: 3,
          nodeOpId,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

      const unpackedExitRequestIndex = 2;

      // Report not unpacked.
      await vebo.setExitRequests(encodedExitRequestsHash, [], exitRequests);
      expect((await vebo.getExitRequestsDeliveryHistory(encodedExitRequestsHash)).length).to.equal(0);

      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, unpackedExitRequestIndex)],
          encodedExitRequests,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "KeyWasNotUnpacked");

      const futureBlockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, unpackedExitRequestIndex)],
          encodedExitRequests,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "KeyWasNotUnpacked");

      // Report not fully unpacked.
      await vebo.setExitRequests(encodedExitRequestsHash, [{ timestamp: 0n, lastDeliveredKeyIndex: 1n }], exitRequests);
      expect((await vebo.getExitRequestsDeliveryHistory(encodedExitRequestsHash)).length).to.equal(1);

      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, unpackedExitRequestIndex)],
          encodedExitRequests,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "KeyWasNotUnpacked");

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, unpackedExitRequestIndex)],
          encodedExitRequests,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "KeyWasNotUnpacked");
    });

    it("reverts if the oldBlock proof is corrupted", async () => {
      const timestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
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
          EMPTY_REPORT,
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
          pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

      await vebo.setExitRequests(
        encodedExitRequestsHash,
        [{ timestamp: veboExitRequestTimestamp, lastDeliveredKeyIndex: 1n }],
        exitRequests,
      );

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
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, timestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [badWitness],
          encodedExitRequests,
        ),
      ).to.be.reverted;
    });
  });
});
