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

  const FIRST_SUPPORTED_SLOT = ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot;
  const PIVOT_SLOT = ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot;
  const SLOTS_PER_EPOCH = 32;
  const SECONDS_PER_SLOT = 12;
  const GENESIS_TIME = 1606824000;
  const SHARD_COMMITTEE_PERIOD_IN_SECONDS = 8192;
  const LIDO_LOCATOR = "0x0000000000000000000000000000000000000001";
  const CAPELLA_SLOT = ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot;
  const SLOTS_PER_HISTORICAL_ROOT = 8192;

  describe("ValidatorExitDelayVerifier Constructor", () => {
    const GI_FIRST_VALIDATOR_PREV = "0x0000000000000000000000000000000000000000000000000096000000000028";
    const GI_FIRST_VALIDATOR_CURR = "0x0000000000000000000000000000000000000000000000000096000000000028";
    const GI_FIRST_HISTORICAL_SUMMARY_PREV = "0x000000000000000000000000000000000000000000000000000000b600000018";
    const GI_FIRST_HISTORICAL_SUMMARY_CURR = "0x000000000000000000000000000000000000000000000000000000b600000018";
    const GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV = "0x000000000000000000000000000000000000000000000000000000000040000d";
    const GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR = "0x000000000000000000000000000000000000000000000000000000000040000d";

    let validatorExitDelayVerifier: ValidatorExitDelayVerifier;

    before(async () => {
      validatorExitDelayVerifier = await ethers.deployContract("ValidatorExitDelayVerifier", [
        LIDO_LOCATOR,
        {
          gIFirstValidatorPrev: GI_FIRST_VALIDATOR_PREV,
          gIFirstValidatorCurr: GI_FIRST_VALIDATOR_CURR,
          gIFirstHistoricalSummaryPrev: GI_FIRST_HISTORICAL_SUMMARY_PREV,
          gIFirstHistoricalSummaryCurr: GI_FIRST_HISTORICAL_SUMMARY_CURR,
          gIFirstBlockRootInSummaryPrev: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV,
          gIFirstBlockRootInSummaryCurr: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR,
        },
        FIRST_SUPPORTED_SLOT,
        PIVOT_SLOT,
        CAPELLA_SLOT,
        SLOTS_PER_HISTORICAL_ROOT,
        SLOTS_PER_EPOCH,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      ]);
    });

    it("sets all parameters correctly", async () => {
      console.log(await validatorExitDelayVerifier.GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV(), "????");
      expect(await validatorExitDelayVerifier.LOCATOR()).to.equal(LIDO_LOCATOR);
      expect(await validatorExitDelayVerifier.GI_FIRST_VALIDATOR_PREV()).to.equal(GI_FIRST_VALIDATOR_PREV);
      expect(await validatorExitDelayVerifier.GI_FIRST_VALIDATOR_CURR()).to.equal(GI_FIRST_VALIDATOR_CURR);
      expect(await validatorExitDelayVerifier.GI_FIRST_HISTORICAL_SUMMARY_PREV()).to.equal(
        GI_FIRST_HISTORICAL_SUMMARY_PREV,
      );
      expect(await validatorExitDelayVerifier.GI_FIRST_HISTORICAL_SUMMARY_CURR()).to.equal(
        GI_FIRST_HISTORICAL_SUMMARY_CURR,
      );
      expect(await validatorExitDelayVerifier.GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV()).to.equal(
        GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV,
      );
      expect(await validatorExitDelayVerifier.GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR()).to.equal(
        GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR,
      );
      expect(await validatorExitDelayVerifier.FIRST_SUPPORTED_SLOT()).to.equal(FIRST_SUPPORTED_SLOT);
      expect(await validatorExitDelayVerifier.PIVOT_SLOT()).to.equal(PIVOT_SLOT);
      expect(await validatorExitDelayVerifier.SLOTS_PER_EPOCH()).to.equal(SLOTS_PER_EPOCH);
      expect(await validatorExitDelayVerifier.SECONDS_PER_SLOT()).to.equal(SECONDS_PER_SLOT);
      expect(await validatorExitDelayVerifier.GENESIS_TIME()).to.equal(GENESIS_TIME);
      expect(await validatorExitDelayVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS()).to.equal(
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      );
      expect(await validatorExitDelayVerifier.CAPELLA_SLOT()).to.equal(CAPELLA_SLOT);
      expect(await validatorExitDelayVerifier.SLOTS_PER_HISTORICAL_ROOT()).to.equal(SLOTS_PER_HISTORICAL_ROOT);
    });

    it("reverts with 'InvalidPivotSlot' if firstSupportedSlot > pivotSlot", async () => {
      await expect(
        ethers.deployContract("ValidatorExitDelayVerifier", [
          LIDO_LOCATOR,
          {
            gIFirstValidatorPrev: GI_FIRST_VALIDATOR_PREV,
            gIFirstValidatorCurr: GI_FIRST_VALIDATOR_CURR,
            gIFirstHistoricalSummaryPrev: GI_FIRST_HISTORICAL_SUMMARY_PREV,
            gIFirstHistoricalSummaryCurr: GI_FIRST_HISTORICAL_SUMMARY_CURR,
            gIFirstBlockRootInSummaryPrev: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV,
            gIFirstBlockRootInSummaryCurr: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR,
          },
          200_000, // firstSupportedSlot
          100_000, // pivotSlot < firstSupportedSlot
          CAPELLA_SLOT,
          SLOTS_PER_HISTORICAL_ROOT,
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
          {
            gIFirstValidatorPrev: GI_FIRST_VALIDATOR_PREV,
            gIFirstValidatorCurr: GI_FIRST_VALIDATOR_CURR,
            gIFirstHistoricalSummaryPrev: GI_FIRST_HISTORICAL_SUMMARY_PREV,
            gIFirstHistoricalSummaryCurr: GI_FIRST_HISTORICAL_SUMMARY_CURR,
            gIFirstBlockRootInSummaryPrev: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV,
            gIFirstBlockRootInSummaryCurr: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR,
          },
          FIRST_SUPPORTED_SLOT,
          PIVOT_SLOT,
          CAPELLA_SLOT,
          SLOTS_PER_HISTORICAL_ROOT,
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

    it("reverts with 'InvalidCapellaSlot' if capellaSlot > firstSupportedSlot", async () => {
      await expect(
        ethers.deployContract("ValidatorExitDelayVerifier", [
          LIDO_LOCATOR,
          {
            gIFirstValidatorPrev: GI_FIRST_VALIDATOR_PREV,
            gIFirstValidatorCurr: GI_FIRST_VALIDATOR_CURR,
            gIFirstHistoricalSummaryPrev: GI_FIRST_HISTORICAL_SUMMARY_PREV,
            gIFirstHistoricalSummaryCurr: GI_FIRST_HISTORICAL_SUMMARY_CURR,
            gIFirstBlockRootInSummaryPrev: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV,
            gIFirstBlockRootInSummaryCurr: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR,
          },
          FIRST_SUPPORTED_SLOT,
          PIVOT_SLOT,
          FIRST_SUPPORTED_SLOT + 1, // Invalid Capella slot
          SLOTS_PER_HISTORICAL_ROOT,
          SLOTS_PER_EPOCH,
          SECONDS_PER_SLOT,
          GENESIS_TIME,
          SHARD_COMMITTEE_PERIOD_IN_SECONDS,
        ]),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "InvalidCapellaSlot");
    });
  });

  describe("verifyValidatorExitDelay method", () => {
    const GI_FIRST_VALIDATOR_PREV = "0x0000000000000000000000000000000000000000000000000096000000000028";
    const GI_FIRST_VALIDATOR_CURR = "0x0000000000000000000000000000000000000000000000000096000000000028";
    const GI_FIRST_HISTORICAL_SUMMARY_PREV = "0x000000000000000000000000000000000000000000000000000000b600000018";
    const GI_FIRST_HISTORICAL_SUMMARY_CURR = "0x000000000000000000000000000000000000000000000000000000b600000018";
    const GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV = "0x000000000000000000000000000000000000000000000000000000000040000d";
    const GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR = "0x000000000000000000000000000000000000000000000000000000000040000d";
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
        {
          gIFirstValidatorPrev: GI_FIRST_VALIDATOR_PREV,
          gIFirstValidatorCurr: GI_FIRST_VALIDATOR_CURR,
          gIFirstHistoricalSummaryPrev: GI_FIRST_HISTORICAL_SUMMARY_PREV,
          gIFirstHistoricalSummaryCurr: GI_FIRST_HISTORICAL_SUMMARY_CURR,
          gIFirstBlockRootInSummaryPrev: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV,
          gIFirstBlockRootInSummaryCurr: GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR,
        },
        FIRST_SUPPORTED_SLOT,
        PIVOT_SLOT,
        CAPELLA_SLOT,
        SLOTS_PER_HISTORICAL_ROOT,
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

      await vebo.setExitRequests(encodedExitRequestsHash, veboExitRequestTimestamp, exitRequests);

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

    it("report exit delay with uses earliest possible voluntary exit time when it's greater than exit request timestamp", async () => {
      const activationEpochTimestamp =
        GENESIS_TIME + Number(ACTIVE_VALIDATOR_PROOF.validator.activationEpoch) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      const earliestPossibleVoluntaryExitTimestamp =
        activationEpochTimestamp + Number(await validatorExitDelayVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS());
      const proofSlotTimestamp = GENESIS_TIME + ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot * SECONDS_PER_SLOT;
      const expectedSecondsSinceEligibleExit = proofSlotTimestamp - earliestPossibleVoluntaryExitTimestamp;

      //The exit request happens before the earliest possible exit time!
      const veboExitRequestTimestamp = earliestPossibleVoluntaryExitTimestamp - 1000;

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

      await vebo.setExitRequests(encodedExitRequestsHash, veboExitRequestTimestamp, exitRequests);

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);
      const futureBlockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      const verifyExitDelayEvents = async (tx: ContractTransactionResponse) => {
        const receipt = await tx.wait();
        const events = findStakingRouterMockEvents(receipt!, "UnexitedValidatorReported");
        expect(events.length).to.equal(1);

        const event = events[0];
        expect(event.args[0]).to.equal(moduleId);
        expect(event.args[1]).to.equal(nodeOpId);
        expect(event.args[2]).to.equal(proofSlotTimestamp);
        expect(event.args[3]).to.equal(ACTIVE_VALIDATOR_PROOF.validator.pubkey);
        expect(event.args[4]).to.equal(expectedSecondsSinceEligibleExit);
      };

      await verifyExitDelayEvents(
        await validatorExitDelayVerifier.verifyValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          encodedExitRequests,
        ),
      );

      await verifyExitDelayEvents(
        await validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
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

    it("reverts with 'ExitIsNotEligibleOnProvableBeaconBlock' when the when proof slot is early then exit request time", async () => {
      const intervalInSecondsAfterProofSlot = 1;

      const proofSlotTimestamp = GENESIS_TIME + ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot * SECONDS_PER_SLOT;
      const veboExitRequestTimestamp = proofSlotTimestamp + intervalInSecondsAfterProofSlot;

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

      await vebo.setExitRequests(encodedExitRequestsHash, veboExitRequestTimestamp, exitRequests);

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          encodedExitRequests,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "ExitIsNotEligibleOnProvableBeaconBlock");

      const futureBlockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
          encodedExitRequests,
        ),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "ExitIsNotEligibleOnProvableBeaconBlock");
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

      await vebo.setExitRequests(encodedExitRequestsHash, veboExitRequestTimestamp, exitRequests);

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

    it("reverts with 'RequestsNotDelivered' if exit request index is not in delivery history", async () => {
      const exitRequests: ExitRequest[] = [
        {
          moduleId: 1,
          nodeOpId: 1,
          valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
          pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        },
      ];
      const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

      const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);
      const futureBlockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

      const unpackedExitRequestIndex = 0;

      // Report not unpacked, deliveryTimestamp == 0
      await vebo.setExitRequests(encodedExitRequestsHash, 0, exitRequests);

      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, unpackedExitRequestIndex)],
          encodedExitRequests,
        ),
      ).to.be.revertedWithCustomError(vebo, "RequestsNotDelivered");

      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
          toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
          [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, unpackedExitRequestIndex)],
          encodedExitRequests,
        ),
      ).to.be.revertedWithCustomError(vebo, "RequestsNotDelivered");
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

      await vebo.setExitRequests(encodedExitRequestsHash, veboExitRequestTimestamp, exitRequests);

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
