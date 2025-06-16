// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IStakingRouter} from "contracts/common/interfaces/IStakingRouter.sol";
import {BeaconBlockHeader, Validator} from "contracts/common/lib/BeaconTypes.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IValidatorsExitBus} from "contracts/common/interfaces/IValidatorsExitBus.sol";

struct ExitRequestData {
    bytes data;
    uint256 dataFormat;
}

struct ValidatorWitness {
    // The index of an exit request in the VEB exit requests data
    uint32 exitRequestIndex;
    // -------------------- Validator details -------------------
    bytes32 withdrawalCredentials;
    uint64 effectiveBalance;
    bool slashed;
    uint64 activationEligibilityEpoch;
    uint64 activationEpoch;
    uint64 withdrawableEpoch;
    // ------------------------ Proof ---------------------------
    bytes32[] validatorProof;
}

struct ProvableBeaconBlockHeader {
    BeaconBlockHeader header; // Header of the block which root is known at 'rootsTimestamp'.
    uint64 rootsTimestamp; // Timestamp passed to EIP-4788 block roots contract to retrieve the known block root.
}

// A witness for a block header which root is accessible via `historical_summaries` field.
struct HistoricalHeaderWitness {
    BeaconBlockHeader header;
    GIndex rootGIndex; // The generalized index of the old block root in the historical_summaries.
    bytes32[] proof; // The Merkle proof for the old block header against the state's historical_summaries root.
}

/**
 * @title ValidatorExitDelayVerifier
 * @notice Allows permissionless reporting of exit delays for validators that have been requested to exit
 *         via the Validator Exit Bus.
 *
 * @dev Uses EIP-4788 to confirm the correctness of a given beacon block root.
 */
contract ValidatorExitDelayVerifier {
    using SSZ for Validator;
    using SSZ for BeaconBlockHeader;

    /// @notice EIP-4788 contract address that provides a mapping of timestamp -> known beacon block root.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    uint64 private constant FAR_FUTURE_EPOCH = type(uint64).max;

    uint64 public immutable GENESIS_TIME;
    uint32 public immutable SLOTS_PER_EPOCH;
    uint32 public immutable SECONDS_PER_SLOT;
    uint32 public immutable SHARD_COMMITTEE_PERIOD_IN_SECONDS;

    /**
     * @notice The GIndex pointing to BeaconState.validators[0] for the "previous" fork.
     * @dev Used to derive the correct GIndex when verifying proofs for a block prior to pivot.
     */
    GIndex public immutable GI_FIRST_VALIDATOR_PREV;

    /**
     * @notice The GIndex pointing to BeaconState.validators[0] for the "current" fork.
     * @dev Used to derive the correct GIndex when verifying proofs for a block after the pivot slot.
     */
    GIndex public immutable GI_FIRST_VALIDATOR_CURR;

    /**
     * @notice The GIndex pointing to BeaconState.historical_summaries for the "previous" fork.
     * @dev Used when verifying old blocks (i.e., blocks with slot < PIVOT_SLOT).
     */
    GIndex public immutable GI_HISTORICAL_SUMMARIES_PREV;

    /**
     * @notice The GIndex pointing to BeaconState.historical_summaries for the "current" fork.
     * @dev Used when verifying old blocks (i.e., blocks with slot >= PIVOT_SLOT).
     */
    GIndex public immutable GI_HISTORICAL_SUMMARIES_CURR;

    /// @notice The first slot this verifier will accept proofs for.
    uint64 public immutable FIRST_SUPPORTED_SLOT;

    /// @notice The first slot of the currently-compatible fork.
    uint64 public immutable PIVOT_SLOT;

    ILidoLocator public immutable LOCATOR;

    error RootNotFound();
    error InvalidGIndex();
    error InvalidBlockHeader();
    error UnsupportedSlot(uint64 slot);
    error InvalidPivotSlot();
    error ZeroLidoLocatorAddress();
    error ExitIsNotEligibleOnProvableBeaconBlock(
        uint256 provableBeaconBlockTimestamp,
        uint256 eligibleExitRequestTimestamp
    );
    error EmptyDeliveryHistory();

    /**
     * @dev The previous and current forks can be essentially the same.
     * @param lidoLocator The address of the LidoLocator contract.
     * @param gIFirstValidatorPrev GIndex pointing to validators[0] on the previous fork.
     * @param gIFirstValidatorCurr GIndex pointing to validators[0] on the current fork.
     * @param gIHistoricalSummariesPrev GIndex pointing to the historical_summaries on the previous fork.
     * @param gIHistoricalSummariesCurr GIndex pointing to the historical_summaries on the current fork.
     * @param firstSupportedSlot The earliest slot number that proofs can be submitted for verification.
     * @param pivotSlot The pivot slot number used to differentiate "previous" vs "current" fork indexing.
     * @param slotsPerEpoch Number of slots per epoch in Ethereum consensus.
     * @param secondsPerSlot Duration of a single slot, in seconds, in Ethereum consensus.
     * @param genesisTime Genesis timestamp of the Ethereum Beacon chain.
     * @param shardCommitteePeriodInSeconds The length of the shard committee period, in seconds.
     */
    constructor(
        address lidoLocator,
        GIndex gIFirstValidatorPrev,
        GIndex gIFirstValidatorCurr,
        GIndex gIHistoricalSummariesPrev,
        GIndex gIHistoricalSummariesCurr,
        uint64 firstSupportedSlot,
        uint64 pivotSlot,
        uint32 slotsPerEpoch,
        uint32 secondsPerSlot,
        uint64 genesisTime,
        uint32 shardCommitteePeriodInSeconds
    ) {
        if (lidoLocator == address(0)) revert ZeroLidoLocatorAddress();
        if (firstSupportedSlot > pivotSlot) revert InvalidPivotSlot();

        LOCATOR = ILidoLocator(lidoLocator);

        GI_FIRST_VALIDATOR_PREV = gIFirstValidatorPrev;
        GI_FIRST_VALIDATOR_CURR = gIFirstValidatorCurr;

        GI_HISTORICAL_SUMMARIES_PREV = gIHistoricalSummariesPrev;
        GI_HISTORICAL_SUMMARIES_CURR = gIHistoricalSummariesCurr;

        FIRST_SUPPORTED_SLOT = firstSupportedSlot;
        PIVOT_SLOT = pivotSlot;
        SLOTS_PER_EPOCH = slotsPerEpoch;
        SECONDS_PER_SLOT = secondsPerSlot;
        GENESIS_TIME = genesisTime;
        SHARD_COMMITTEE_PERIOD_IN_SECONDS = shardCommitteePeriodInSeconds;
    }

    // ------------------------- External Functions -------------------------

    /**
     * @notice Verifies that the provided validators were not requested to exit on the CL after a VEB exit request.
     *         Reports exit delays to the Staking Router.
     * @dev Ensures that `exitEpoch` is equal to `FAR_FUTURE_EPOCH` at the given beacon block.
     * @param beaconBlock The block header and EIP-4788 timestamp to prove the block root is known.
     * @param validatorWitnesses Array of validator proofs to confirm they are not yet exited.
     * @param exitRequests The concatenated VEBO exit requests, each 64 bytes in length.
     */
    function verifyValidatorExitDelay(
        ProvableBeaconBlockHeader calldata beaconBlock,
        ValidatorWitness[] calldata validatorWitnesses,
        ExitRequestData calldata exitRequests
    ) external {
        _verifyBeaconBlockRoot(beaconBlock);

        IValidatorsExitBus veb = IValidatorsExitBus(LOCATOR.validatorsExitBusOracle());
        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());

        uint256 deliveredTimestamp = _getExitRequestDeliveryTimestamp(veb, exitRequests);
        uint256 proofSlotTimestamp = _slotToTimestamp(beaconBlock.header.slot);

        for (uint256 i = 0; i < validatorWitnesses.length; i++) {
            ValidatorWitness calldata witness = validatorWitnesses[i];

            (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) = veb.unpackExitRequest(
                exitRequests.data,
                exitRequests.dataFormat,
                witness.exitRequestIndex
            );

            uint256 eligibleToExitInSec = _getSecondsSinceExitIsEligible(
                deliveredTimestamp,
                witness.activationEpoch,
                proofSlotTimestamp
            );

            _verifyValidatorExitUnset(beaconBlock.header, validatorWitnesses[i], pubkey, valIndex);

            stakingRouter.reportValidatorExitDelay(moduleId, nodeOpId, proofSlotTimestamp, pubkey, eligibleToExitInSec);
        }
    }

    /**
     * @notice Verifies that the provided validators were not requested to exit on the CL after a VEB exit request.
     *         Reports exit delays to the Staking Router.
     * @dev Ensures that `exitEpoch` is equal to `FAR_FUTURE_EPOCH` at the given beacon block.
     * @dev Verifies historical blocks (via historical_summaries).
     * @dev The oldBlock.header must have slot >= FIRST_SUPPORTED_SLOT.
     * @param beaconBlock The block header and EIP-4788 timestamp to prove the block root is known.
     * @param oldBlock Historical block header witness data and its proof.
     * @param validatorWitnesses Array of validator proofs to confirm they are not yet exited in oldBlock.header.
     * @param exitRequests The concatenated VEBO exit requests, each 64 bytes in length.
     */
    function verifyHistoricalValidatorExitDelay(
        ProvableBeaconBlockHeader calldata beaconBlock,
        HistoricalHeaderWitness calldata oldBlock,
        ValidatorWitness[] calldata validatorWitnesses,
        ExitRequestData calldata exitRequests
    ) external {
        _verifyBeaconBlockRoot(beaconBlock);
        _verifyHistoricalBeaconBlockRoot(beaconBlock, oldBlock);

        IValidatorsExitBus veb = IValidatorsExitBus(LOCATOR.validatorsExitBusOracle());
        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());

        uint256 deliveredTimestamp = _getExitRequestDeliveryTimestamp(veb, exitRequests);
        uint256 proofSlotTimestamp = _slotToTimestamp(oldBlock.header.slot);

        for (uint256 i = 0; i < validatorWitnesses.length; i++) {
            ValidatorWitness calldata witness = validatorWitnesses[i];

            (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) = veb.unpackExitRequest(
                exitRequests.data,
                exitRequests.dataFormat,
                witness.exitRequestIndex
            );

            uint256 eligibleToExitInSec = _getSecondsSinceExitIsEligible(
                deliveredTimestamp,
                witness.activationEpoch,
                proofSlotTimestamp
            );

            _verifyValidatorExitUnset(oldBlock.header, witness, pubkey, valIndex);

            stakingRouter.reportValidatorExitDelay(moduleId, nodeOpId, proofSlotTimestamp, pubkey, eligibleToExitInSec);
        }
    }

    /**
     * @dev Verifies the beacon block header is known in EIP-4788.
     * @param beaconBlock The provable beacon block header and the EIP-4788 timestamp.
     */
    function _verifyBeaconBlockRoot(ProvableBeaconBlockHeader calldata beaconBlock) internal view {
        if (beaconBlock.header.slot < FIRST_SUPPORTED_SLOT) {
            revert UnsupportedSlot(beaconBlock.header.slot);
        }

        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(beaconBlock.rootsTimestamp));
        if (!success || data.length == 0) {
            revert RootNotFound();
        }

        bytes32 trustedRoot = abi.decode(data, (bytes32));
        if (trustedRoot != beaconBlock.header.hashTreeRoot()) {
            revert InvalidBlockHeader();
        }
    }

    function _verifyHistoricalBeaconBlockRoot(
        ProvableBeaconBlockHeader calldata beaconBlock,
        HistoricalHeaderWitness calldata oldBlock
    ) internal view {
        if (oldBlock.header.slot < FIRST_SUPPORTED_SLOT) {
            revert UnsupportedSlot(oldBlock.header.slot);
        }

        if (!_getHistoricalSummariesGI(beaconBlock.header.slot).isParentOf(oldBlock.rootGIndex)) {
            revert InvalidGIndex();
        }

        SSZ.verifyProof({
            proof: oldBlock.proof,
            root: beaconBlock.header.stateRoot,
            leaf: oldBlock.header.hashTreeRoot(),
            gI: oldBlock.rootGIndex
        });
    }

    /**
     * @notice Proves—via an SSZ Merkle proof—that the validator
     *         has not scheduled nor completed an exit.
     *
     * @dev    It reconstructs the `Validator` object with `exitEpoch` hard-coded
     *         to `FAR_FUTURE_EPOCH` and checks that this leaf is present under
     *         the supplied `stateRoot`.
     *
     *         Reverts if proof verification fail.
     */
    function _verifyValidatorExitUnset(
        BeaconBlockHeader calldata header,
        ValidatorWitness calldata witness,
        bytes memory pubkey,
        uint256 validatorIndex
    ) internal view {
        Validator memory validator = Validator({
            pubkey: pubkey,
            withdrawalCredentials: witness.withdrawalCredentials,
            effectiveBalance: witness.effectiveBalance,
            slashed: witness.slashed,
            activationEligibilityEpoch: witness.activationEligibilityEpoch,
            activationEpoch: witness.activationEpoch,
            exitEpoch: FAR_FUTURE_EPOCH,
            withdrawableEpoch: witness.withdrawableEpoch
        });

        SSZ.verifyProof({
            proof: witness.validatorProof,
            root: header.stateRoot,
            leaf: validator.hashTreeRoot(),
            gI: _getValidatorGI(validatorIndex, header.slot)
        });
    }

    /**
     * @dev Determines how many seconds have passed since a validator was first eligible
     *      to exit after VEB exit request.
     * @return uint256 The elapsed seconds since the earliest eligible exit request time.
     */
    function _getSecondsSinceExitIsEligible(
        uint256 deliveredTimestamp,
        uint256 activationEpoch,
        uint256 referenceSlotTimestamp
    ) internal view returns (uint256) {
        // The earliest a validator can voluntarily exit is after the Shard Committee Period
        // subsequent to its activation epoch.
        uint256 earliestPossibleVoluntaryExitTimestamp = GENESIS_TIME +
            (activationEpoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT) +
            SHARD_COMMITTEE_PERIOD_IN_SECONDS;

        // The actual eligible timestamp is the max between the exit request submission time
        // and the earliest possible voluntary exit time.
        uint256 eligibleExitRequestTimestamp = deliveredTimestamp > earliestPossibleVoluntaryExitTimestamp
            ? deliveredTimestamp
            : earliestPossibleVoluntaryExitTimestamp;

        if (referenceSlotTimestamp < eligibleExitRequestTimestamp) {
            revert ExitIsNotEligibleOnProvableBeaconBlock(referenceSlotTimestamp, eligibleExitRequestTimestamp);
        }

        return referenceSlotTimestamp - eligibleExitRequestTimestamp;
    }

    function _getValidatorGI(uint256 offset, uint64 stateSlot) internal view returns (GIndex) {
        GIndex gI = stateSlot < PIVOT_SLOT ? GI_FIRST_VALIDATOR_PREV : GI_FIRST_VALIDATOR_CURR;
        return gI.shr(offset);
    }

    function _getHistoricalSummariesGI(uint64 stateSlot) internal view returns (GIndex) {
        return stateSlot < PIVOT_SLOT ? GI_HISTORICAL_SUMMARIES_PREV : GI_HISTORICAL_SUMMARIES_CURR;
    }

    function _getExitRequestDeliveryTimestamp(
        IValidatorsExitBus veb,
        ExitRequestData calldata exitRequests
    ) internal view returns (uint256 deliveryTimestamp) {
        bytes32 exitRequestsHash = keccak256(abi.encode(exitRequests.data, exitRequests.dataFormat));
        deliveryTimestamp = veb.getDeliveryTimestamp(exitRequestsHash);

        if (deliveryTimestamp == 0) {
            revert EmptyDeliveryHistory();
        }
    }

    function _slotToTimestamp(uint64 slot) internal view returns (uint256) {
        return GENESIS_TIME + slot * SECONDS_PER_SLOT;
    }
}
