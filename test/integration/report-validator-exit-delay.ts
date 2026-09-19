import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, ether, getCurrentBlockTimestamp, updateBeaconBlockRoot } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import {
  encodeExitRequestsDataListWithFormat,
  generateValidatorStateProof,
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

  const HOUR = 3600n;
  const DAY = 24n * HOUR;
  // Any index works: the state tree is generated around whatever index the exit request carries.
  const VALIDATOR_INDEX = 1;

  /**
   * Picks a proof slot `lead` seconds ahead of chain time, so a test can wind the clock forward to
   * the moment it needs.
   *
   * Which side of the Gloas fork the slot lands on — and therefore which validator GIndex layout
   * the proof has to use — follows the deployed verifier's own configuration: the pre-Gloas layout
   * where the fork slot is still the sentinel, the progressive-list one on a devnet that sets a
   * real fork slot.
   */
  const pickProofSlot = async (lead: bigint): Promise<number> => {
    const { validatorExitDelayVerifier } = ctx.contracts;
    const [genesisTime, secondsPerSlot, firstSupportedSlot] = await Promise.all([
      validatorExitDelayVerifier.GENESIS_TIME(),
      validatorExitDelayVerifier.SECONDS_PER_SLOT(),
      validatorExitDelayVerifier.FIRST_SUPPORTED_SLOT(),
    ]);

    const target = ((await getCurrentBlockTimestamp()) + lead - genesisTime) / BigInt(secondsPerSlot);
    return Number(target > firstSupportedSlot ? target : firstSupportedSlot + 1n);
  };

  const slotToTimestamp = async (slot: number): Promise<bigint> => {
    const { validatorExitDelayVerifier } = ctx.contracts;
    const [genesisTime, secondsPerSlot] = await Promise.all([
      validatorExitDelayVerifier.GENESIS_TIME(),
      validatorExitDelayVerifier.SECONDS_PER_SLOT(),
    ]);

    return genesisTime + BigInt(slot) * BigInt(secondsPerSlot);
  };

  before(async () => {
    ctx = await getProtocolContext();
    rootSnapshot = await Snapshot.take();

    [vebReportSubmitter] = await ethers.getSigners();

    const { nor, stakingRouter, validatorsExitBusOracle, validatorExitDelayVerifier } = ctx.contracts;

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
    expect(await validatorExitDelayVerifier.GI_FIRST_VALIDATOR_PRE_GLOAS()).to.equal(
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
    // Leave the validator eligible to exit for a full day past the deadline, so the penalty
    // is unambiguously applicable.
    const delay = (await nor.exitDeadlineThreshold(0)) + DAY;
    const proofSlot = await pickProofSlot(delay + HOUR);
    const proof = await generateValidatorStateProof(validatorExitDelayVerifier, proofSlot, VALIDATOR_INDEX);

    const exitRequests = [{ moduleId, nodeOpId, valIndex: proof.validatorIndex, pubkey: proof.pubkey }];
    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

    const proofSlotTimestamp = await slotToTimestamp(proofSlot);
    await advanceChainTime(proofSlotTimestamp - (await getCurrentBlockTimestamp()) - delay);

    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);
    await validatorsExitBusOracle.submitExitRequestsData(encodedExitRequests);

    const deliveryTimestamp = await validatorsExitBusOracle.getDeliveryTimestamp(encodedExitRequestsHash);
    const eligibleToExitInSec = proofSlotTimestamp - deliveryTimestamp;

    const blockRootTimestamp = await updateBeaconBlockRoot(proof.headerRoot);

    expect(
      await nor.isValidatorExitDelayPenaltyApplicable(nodeOpId, proofSlotTimestamp, proof.pubkey, eligibleToExitInSec),
    ).to.be.true;

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(proof.header, blockRootTimestamp),
        [proof.witness],
        encodedExitRequests,
      ),
    )
      .and.to.emit(nor, "ValidatorExitStatusUpdated")
      .withArgs(nodeOpId, proof.pubkey, eligibleToExitInSec, proofSlotTimestamp);

    expect(
      await nor.isValidatorExitDelayPenaltyApplicable(nodeOpId, proofSlotTimestamp, proof.pubkey, eligibleToExitInSec),
    ).to.be.false;

    // A second report for the same key is a no-op rather than a revert.
    const tx = validatorExitDelayVerifier.verifyValidatorExitDelay(
      toProvableBeaconBlockHeader(proof.header, blockRootTimestamp),
      [proof.witness],
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
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

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
      pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
    }));

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

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
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests } = encodeExitRequestsDataListWithFormat(exitRequests);

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
        pubkey: ACTIVE_VALIDATOR_PROOF.validator.pubkey,
      },
    ];

    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

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
    const proofSlot = await pickProofSlot(HOUR);
    const proof = await generateValidatorStateProof(validatorExitDelayVerifier, proofSlot, VALIDATOR_INDEX);

    const exitRequests = [{ moduleId, nodeOpId, valIndex: proof.validatorIndex, pubkey: proof.pubkey }];
    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);
    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);
    await validatorsExitBusOracle.submitExitRequestsData(encodedExitRequests);

    // Use a different block root that won't match the header
    const fakeRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
    const mismatchTimestamp = await updateBeaconBlockRoot(fakeRoot);

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(proof.header, mismatchTimestamp),
        [proof.witness],
        encodedExitRequests,
      ),
    ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "InvalidBlockHeader");
  });

  it("Should revert when reporting validator exit delay before exit deadline threshold", async () => {
    const { nor, validatorsExitBusOracle, validatorExitDelayVerifier } = ctx.contracts;

    const nodeOpId = 2;
    const exitDeadlineThreshold = await nor.exitDeadlineThreshold(0);
    const proofSlot = await pickProofSlot(exitDeadlineThreshold + HOUR);
    const proof = await generateValidatorStateProof(validatorExitDelayVerifier, proofSlot, VALIDATOR_INDEX);

    const exitRequests = [{ moduleId, nodeOpId, valIndex: proof.validatorIndex, pubkey: proof.pubkey }];
    const { encodedExitRequests, encodedExitRequestsHash } = encodeExitRequestsDataListWithFormat(exitRequests);

    const proofSlotTimestamp = await slotToTimestamp(proofSlot);
    // Deliver the request late enough that the validator has not been eligible to exit for the
    // full deadline window, which is what the module is expected to reject.
    await advanceChainTime(proofSlotTimestamp - (await getCurrentBlockTimestamp()) - exitDeadlineThreshold);

    await validatorsExitBusOracle.connect(vebReportSubmitter).submitExitRequestsHash(encodedExitRequestsHash);
    await validatorsExitBusOracle.submitExitRequestsData(encodedExitRequests);

    const deliveryTimestamp = await validatorsExitBusOracle.getDeliveryTimestamp(encodedExitRequestsHash);
    const eligibleToExitInSec = proofSlotTimestamp - deliveryTimestamp;

    const blockRootTimestamp = await updateBeaconBlockRoot(proof.headerRoot);

    expect(
      await nor.isValidatorExitDelayPenaltyApplicable(nodeOpId, proofSlotTimestamp, proof.pubkey, eligibleToExitInSec),
    ).to.be.false;

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(proof.header, blockRootTimestamp),
        [proof.witness],
        encodedExitRequests,
      ),
    ).to.be.revertedWith("EXIT_DELAY_BELOW_THRESHOLD");
  });
});
