import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, ether, getCurrentBlockTimestamp, updateBeaconBlockRoot } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { norSdvtAddSigningKey, norSdvtEnsureOperators } from "lib/protocol/helpers";

import {
  encodeExitRequestsDataListWithFormatV2,
  toHistoricalHeaderWitness,
  toProvableBeaconBlockHeader,
  toValidatorWitness,
} from "test/0.8.25/validatorExitDelayVerifierHelpers";
import { ACTIVE_VALIDATOR_PROOF } from "test/0.8.25/validatorState";
import { Snapshot } from "test/suite";

describe("Integration: Report Validator Exit Delay", () => {
  let ctx: ProtocolContext;
  let rootSnapshot: string;
  let beforeEachSnapshot: string;

  let vebReportSubmitter: HardhatEthersSigner;

  const moduleId = 1; // NOR module ID

  // keyIndex at which the proof's validator pubkey is registered for each node operator,
  // required for the format-2 (DATA_FORMAT_LIST_WITH_KEY_INDEX) VEB key verification.
  let keyIndexByNodeOp: Record<number, number>;

  before(async () => {
    ctx = await getProtocolContext();
    rootSnapshot = await Snapshot.take();

    [vebReportSubmitter] = await ethers.getSigners();

    const { nor, stakingRouter, validatorsExitBusOracle, validatorExitDelayVerifier } = ctx.contracts;

    // Ensure node operators exist and register the proof's validator pubkey as an on-chain signing
    // key for the operators used in the tests, so submitExitRequestsData key verification passes.
    await norSdvtEnsureOperators(ctx, nor);
    const proofPubkey = ACTIVE_VALIDATOR_PROOF.validator.pubkey;
    keyIndexByNodeOp = {
      1: Number(await norSdvtAddSigningKey(ctx, nor, { operatorId: 1n, pubkey: proofPubkey })),
      2: Number(await norSdvtAddSigningKey(ctx, nor, { operatorId: 2n, pubkey: proofPubkey })),
    };

    const agentSigner = await ctx.getSigner("agent", ether("1"));
    await validatorsExitBusOracle
      .connect(agentSigner)
      .grantRole(await validatorsExitBusOracle.SUBMIT_REPORT_HASH_ROLE(), vebReportSubmitter.address);

    if (await validatorsExitBusOracle.isPaused()) {
      await validatorsExitBusOracle
        .connect(agentSigner)
        .grantRole(await validatorsExitBusOracle.RESUME_ROLE(), vebReportSubmitter.address);

      await validatorsExitBusOracle.connect(vebReportSubmitter).resume();
    }

    await stakingRouter
      .connect(agentSigner)
      .grantRole(await stakingRouter.REPORT_VALIDATOR_EXITING_STATUS_ROLE(), validatorExitDelayVerifier.address);

    // Ensure that the validatorExitDelayVerifier contract and provided proof use same GI
    expect(await validatorExitDelayVerifier.GI_FIRST_VALIDATOR_CURR()).to.equal(
      ACTIVE_VALIDATOR_PROOF.firstValidatorGI,
    );

    // Ensure that nor is a first module in staking router
    expect((await stakingRouter.getStakingModule(moduleId)).stakingModuleAddress).to.equal(nor.address);
  });

  after(async () => await Snapshot.restore(rootSnapshot));

  beforeEach(async () => (beforeEachSnapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(beforeEachSnapshot));

  it("Should report validator exit delay", async () => {
    const { nor, validatorsExitBusOracle, validatorExitDelayVerifier } = ctx.contracts;

    const nodeOpId = 2;
    const exitRequests = [
      {
        moduleId,
        nodeOpId,
        valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
        keyIndex: keyIndexByNodeOp[nodeOpId],
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormatV2(exitRequests);

    const currentBlockTimestamp = await getCurrentBlockTimestamp();
    const proofSlotTimestamp =
      (await validatorExitDelayVerifier.GENESIS_TIME()) + BigInt(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot * 12);

    // Set the block timestamp to 7 days before the proof time
    await advanceChainTime(proofSlotTimestamp - currentBlockTimestamp - BigInt(3600 * 24 * 7));

    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);
    await validatorsExitBusOracle.submitExitRequestsData(encodedExitRequests);

    const deliveryTimestamp = await validatorsExitBusOracle.getDeliveryTimestamp(encodedExitRequestsHash);
    const eligibleToExitInSec = proofSlotTimestamp - deliveryTimestamp;

    const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

    expect(
      await nor.isValidatorExitDelayPenaltyApplicable(
        nodeOpId,
        proofSlotTimestamp,
        ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        eligibleToExitInSec,
      ),
    ).to.be.true;

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    )
      .and.to.emit(nor, "ValidatorExitStatusUpdated")
      .withArgs(nodeOpId, ACTIVE_VALIDATOR_PROOF.validator.pubkey, eligibleToExitInSec, proofSlotTimestamp);

    expect(
      await nor.isValidatorExitDelayPenaltyApplicable(
        nodeOpId,
        proofSlotTimestamp,
        ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        eligibleToExitInSec,
      ),
    ).to.be.false;

    const tx = validatorExitDelayVerifier.verifyValidatorExitDelay(
      toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
      [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
      encodedExitRequests,
    );

    await expect(tx).to.not.be.reverted;
    await expect(tx).to.not.emit(nor, "ValidatorExitStatusUpdated");
  });

  it("Should report validator exit delay historically", async function () {
    // Skip if not mainnet
    if (!ctx.isMainnet) this.skip();

    const { nor, validatorsExitBusOracle, validatorExitDelayVerifier } = ctx.contracts;
    const nodeOpId = 2;
    const exitRequests = [
      {
        moduleId,
        nodeOpId,
        valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
        keyIndex: keyIndexByNodeOp[nodeOpId],
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormatV2(exitRequests);

    const currentBlockTimestamp = await getCurrentBlockTimestamp();
    const proofSlotTimestamp =
      (await validatorExitDelayVerifier.GENESIS_TIME()) + BigInt(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot * 12);

    // Set the block timestamp to 7 days before the proof time
    await advanceChainTime(proofSlotTimestamp - currentBlockTimestamp - BigInt(3600 * 24 * 7));

    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);
    await validatorsExitBusOracle.submitExitRequestsData(encodedExitRequests);

    const deliveryTimestamp = await validatorsExitBusOracle.getDeliveryTimestamp(encodedExitRequestsHash);
    const eligibleToExitInSec = proofSlotTimestamp - deliveryTimestamp;

    const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

    expect(
      await nor.isValidatorExitDelayPenaltyApplicable(
        nodeOpId,
        proofSlotTimestamp,
        ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        eligibleToExitInSec,
      ),
    ).to.be.true;

    await expect(
      validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, blockRootTimestamp),
        toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    )
      .to.emit(nor, "ValidatorExitStatusUpdated")
      .withArgs(nodeOpId, ACTIVE_VALIDATOR_PROOF.validator.pubkey, eligibleToExitInSec, proofSlotTimestamp);
    expect(
      await nor.isValidatorExitDelayPenaltyApplicable(
        nodeOpId,
        proofSlotTimestamp,
        ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        eligibleToExitInSec,
      ),
    ).to.be.false;

    const tx = validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
      toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, blockRootTimestamp),
      toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
      [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
      encodedExitRequests,
    );

    await expect(tx).to.not.be.reverted;
    await expect(tx).to.not.emit(nor, "ValidatorExitStatusUpdated");
  });

  it("Should revert when validator reported multiple times in a single transaction", async function () {
    // Skip if not mainnet
    if (!ctx.isMainnet) this.skip();

    const { validatorsExitBusOracle, validatorExitDelayVerifier, nor } = ctx.contracts;

    // Setup multiple exit requests with the same pubkey
    const nodeOpIds = [1, 2];
    const exitRequests = nodeOpIds.map((nodeOpId) => ({
      moduleId,
      nodeOpId,
      valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
      keyIndex: keyIndexByNodeOp[nodeOpId],
      pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
    }));

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormatV2(exitRequests);

    const currentBlockTimestamp = await getCurrentBlockTimestamp();
    const proofSlotTimestamp =
      (await validatorExitDelayVerifier.GENESIS_TIME()) + BigInt(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot * 12);

    // Set the block timestamp to 7 days before the proof time
    await advanceChainTime(proofSlotTimestamp - currentBlockTimestamp - BigInt(3600 * 24 * 7));

    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);
    await validatorsExitBusOracle.submitExitRequestsData(encodedExitRequests);

    const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

    const witnesses = nodeOpIds.map((_, index) => toValidatorWitness(ACTIVE_VALIDATOR_PROOF, index));
    const tx = validatorExitDelayVerifier.verifyValidatorExitDelay(
      toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
      witnesses,
      encodedExitRequests,
    );

    await expect(tx).to.not.be.reverted;
    await expect(tx).to.emit(nor, "ValidatorExitStatusUpdated");

    const futureBlockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

    const tx2 = validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
      toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
      toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
      witnesses,
      encodedExitRequests,
    );

    await expect(tx2).to.not.be.reverted;
    await expect(tx2).to.not.emit(nor, "ValidatorExitStatusUpdated");
  });

  it("Should revert when exit request hash is not submitted", async function () {
    // Skip if not mainnet
    if (!ctx.isMainnet) this.skip();

    const { validatorExitDelayVerifier, validatorsExitBusOracle } = ctx.contracts;

    const exitRequests = [
      {
        moduleId,
        nodeOpId: 2,
        valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
        keyIndex: keyIndexByNodeOp[2],
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests } = encodeExitRequestsDataListWithFormatV2(exitRequests);

    // Note that we don't submit the hash to ValidatorsExitBusOracle

    const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    ).to.be.revertedWithCustomError(validatorsExitBusOracle, "ExitHashNotSubmitted");

    const futureBlockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

    await expect(
      validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
        toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    ).to.be.revertedWithCustomError(validatorsExitBusOracle, "ExitHashNotSubmitted");
  });

  it("Should revert when exit request was not unpacked", async function () {
    // Skip if not mainnet
    if (!ctx.isMainnet) this.skip();

    const { validatorExitDelayVerifier, validatorsExitBusOracle } = ctx.contracts;

    const exitRequests = [
      {
        moduleId,
        nodeOpId: 2,
        valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
        keyIndex: keyIndexByNodeOp[2],
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormatV2(exitRequests);

    // Note that we don't submit actual report, only hash
    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);

    const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    ).to.be.revertedWithCustomError(validatorsExitBusOracle, "RequestsNotDelivered");

    const futureBlockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

    await expect(
      validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, futureBlockRootTimestamp),
        toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    ).to.be.revertedWithCustomError(validatorsExitBusOracle, "RequestsNotDelivered");
  });

  it("Should revert when submitting validator exit delay with invalid beacon block root", async () => {
    const { validatorsExitBusOracle, validatorExitDelayVerifier } = ctx.contracts;

    const nodeOpId = 2;
    const exitRequests = [
      {
        moduleId,
        nodeOpId,
        valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
        keyIndex: keyIndexByNodeOp[nodeOpId],
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormatV2(exitRequests);
    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);
    await validatorsExitBusOracle.submitExitRequestsData(encodedExitRequests);

    // Use a different block root that won't match the header
    const fakeRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
    const mismatchTimestamp = await updateBeaconBlockRoot(fakeRoot);

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, mismatchTimestamp),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "InvalidBlockHeader");
  });

  it("Should revert when reporting validator exit delay before exit deadline threshold", async () => {
    const { nor, validatorsExitBusOracle, validatorExitDelayVerifier } = ctx.contracts;

    const nodeOpId = 2;
    const exitRequests = [
      {
        moduleId,
        nodeOpId,
        valIndex: ACTIVE_VALIDATOR_PROOF.validator.index,
        keyIndex: keyIndexByNodeOp[nodeOpId],
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormatV2(exitRequests);

    const currentBlockTimestamp = await getCurrentBlockTimestamp();
    const proofSlotTimestamp =
      (await validatorExitDelayVerifier.GENESIS_TIME()) + BigInt(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot * 12);

    const exitDeadlineThreshold = await nor.exitDeadlineThreshold(0);
    await advanceChainTime(proofSlotTimestamp - currentBlockTimestamp - exitDeadlineThreshold);

    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);
    await validatorsExitBusOracle.submitExitRequestsData(encodedExitRequests);

    const deliveryTimestamp = await validatorsExitBusOracle.getDeliveryTimestamp(encodedExitRequestsHash);
    const eligibleToExitInSec = proofSlotTimestamp - deliveryTimestamp;

    const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

    expect(
      await nor.isValidatorExitDelayPenaltyApplicable(
        nodeOpId,
        proofSlotTimestamp,
        ACTIVE_VALIDATOR_PROOF.validator.pubkey,
        eligibleToExitInSec,
      ),
    ).to.be.false;

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    ).to.be.revertedWith("EXIT_DELAY_BELOW_THRESHOLD");
  });
});
