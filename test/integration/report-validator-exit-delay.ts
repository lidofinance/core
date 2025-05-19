import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, ether, getCurrentBlockTimestamp, updateBeaconBlockRoot } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import {
  encodeExitRequestsDataListWithFormat,
  toHistoricalHeaderWitness,
  toProvableBeaconBlockHeader,
  toValidatorWitness,
} from "test/0.8.25/validatorExitDelayVerifierHelpers";
import { ACTIVE_VALIDATOR_PROOF } from "test/0.8.25/validatorState";
import { Snapshot } from "test/suite";

describe("Report Validator Exit Delay", () => {
  let ctx: ProtocolContext;
  let beforeEachSnapshot: string;

  let vebReportSubmitter: HardhatEthersSigner;

  const moduleId = 1; // NOR module ID

  before(async () => {
    ctx = await getProtocolContext();

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
      .grantRole(await stakingRouter.REPORT_EXITED_VALIDATORS_STATUS_ROLE(), validatorExitDelayVerifier.address);

    // Ensure that the validatorExitDelayVerifier contract and provided proof use same GI
    expect(await validatorExitDelayVerifier.GI_FIRST_VALIDATOR_CURR()).to.equal(
      ACTIVE_VALIDATOR_PROOF.firstValidatorGI,
    );

    // Ensure that nor is a first module in staking router
    expect((await stakingRouter.getStakingModule(moduleId)).stakingModuleAddress).to.equal(nor.address);
  });

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

    const deliveryHistory = await validatorsExitBusOracle.getExitRequestsDeliveryHistory(encodedExitRequestsHash);
    const eligibleToExitInSec = proofSlotTimestamp - deliveryHistory.history[0].timestamp;

    const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.beaconBlockHeaderRoot);

    await expect(
      validatorExitDelayVerifier.verifyValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.beaconBlockHeader, blockRootTimestamp),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    )
      .and.to.emit(nor, "ValidatorExitStatusUpdated")
      .withArgs(nodeOpId, ACTIVE_VALIDATOR_PROOF.validator.pubkey, eligibleToExitInSec, proofSlotTimestamp);
  });

  it("Should report validator exit delay historically", async () => {
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

    const deliveryHistory = await validatorsExitBusOracle.getExitRequestsDeliveryHistory(encodedExitRequestsHash);
    const eligibleToExitInSec = proofSlotTimestamp - deliveryHistory.history[0].timestamp;

    const blockRootTimestamp = await updateBeaconBlockRoot(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeaderRoot);

    await expect(
      validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
        toProvableBeaconBlockHeader(ACTIVE_VALIDATOR_PROOF.futureBeaconBlockHeader, blockRootTimestamp),
        toHistoricalHeaderWitness(ACTIVE_VALIDATOR_PROOF),
        [toValidatorWitness(ACTIVE_VALIDATOR_PROOF, 0)],
        encodedExitRequests,
      ),
    )
      .and.to.emit(nor, "ValidatorExitStatusUpdated")
      .withArgs(nodeOpId, ACTIVE_VALIDATOR_PROOF.validator.pubkey, eligibleToExitInSec, proofSlotTimestamp);
  });
});
