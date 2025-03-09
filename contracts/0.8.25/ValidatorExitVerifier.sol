// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {BeaconBlockHeader, Slot, Validator} from "./lib/Types.sol";
import {GIndex} from "./lib/GIndex.sol";
import {SSZ} from "./lib/SSZ.sol";
import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {IValidatorsExitBusOracle, RequestStatus} from "./interfaces/IValidatorsExitBusOracle.sol";
import {IStakingRouter} from "./interfaces/IStakingRouter.sol";

struct ValidatorWitness {
    // The index of an exit request in the VEBO exit requests data
    uint32 exitRequestIndex;
    // -------------------- Validator details -------------------
    bytes32 withdrawalCredentials;
    uint64 effectiveBalance;
    bool slashed;
    uint64 activationEligibilityEpoch;
    uint64 activationEpoch;
    uint64 exitEpoch;
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
 * @title ValidatorExitVerifier
 * @notice Verifies validator proofs to ensure they are unexited after an exit request.
 *         Allows permissionless report the status of validators which are assumed to have exited but have not.
 * @dev Uses EIP-4788 to confirm the correctness of a given beacon block root.
 */
contract ValidatorExitVerifier {
    using SSZ for Validator;
    using SSZ for BeaconBlockHeader;
    using ExitRequestStatus for RequestStatus;
    using ExitRequests for bytes;

    /// @notice EIP-4788 contract address that provides a mapping of timestamp -> known beacon block root.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    uint64 constant FAR_FUTURE_EPOCH = type(uint64).max;

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
    Slot public immutable FIRST_SUPPORTED_SLOT;

    /// @notice The first slot of the currently-compatible fork.
    Slot public immutable PIVOT_SLOT;

    ILidoLocator public immutable LOCATOR;

    error RootNotFound();
    error InvalidGIndex();
    error InvalidBlockHeader();
    error UnsupportedSlot(Slot slot);
    error InvalidPivotSlot();
    error ZeroLidoLocatorAddress();
    error ExitRequestNotEligibleOnProvableBeaconBlock(
        uint64 provableBeaconBlockTimestamp,
        uint64 eligibleExitRequestTimestamp
    );
    error ValidatorAlreadyRequestedExit(bytes pubkey, uint256 validatorIndex);
    error ExitRequestsCountMismatch(uint256 exitRequestsCount, uint256 exitRequestsCountInExitReportStatus);
    error ChainTimeConfigurationMismatch();

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
        Slot firstSupportedSlot,
        Slot pivotSlot,
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
     * @notice Verifies that provided validators are still active (not exited) at the given beacon block.
     *         If they are unexpectedly still active, it reports them back to the Staking Router.
     * @param exitRequests The concatenated VEBO exit requests, each 64 bytes in length.
     * @param beaconBlock The block header and EIP-4788 timestamp to prove the block root is known.
     * @param validatorWitnesses Array of validator proofs to confirm they are not yet exited.
     */
    function verifyActiveValidatorsAfterExitRequest(
        bytes calldata exitRequests,
        ProvableBeaconBlockHeader calldata beaconBlock,
        ValidatorWitness[] calldata validatorWitnesses
    ) external {
        _verifyBeaconBlockRoot(beaconBlock);

        RequestStatus memory requestStatus = _verifyRequestStatus(exitRequests);

        for (uint256 i = 0; i < validatorWitnesses.length; i++) {
            (bytes calldata pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) = exitRequests
                .unpackExitRequest(validatorWitnesses[i].exitRequestIndex);

            uint64 secondsSinceEligibleExitRequest = _getSecondsSinceExitRequestEligible(
                requestStatus.getValidatorExitRequestTimestamp(validatorWitnesses[i].exitRequestIndex),
                beaconBlock.header.slot,
                validatorWitnesses[i].activationEpoch
            );

            _verifyValidatorIsNotExited(beaconBlock.header, validatorWitnesses[i], pubkey, valIndex);

            IStakingRouter(LOCATOR.stakingRouter()).reportUnexitedValidator(
                moduleId,
                nodeOpId,
                pubkey,
                secondsSinceEligibleExitRequest
            );
        }
    }

    /**
     * @notice Verifies historical blocks (via historical_summaries) and checks that certain validators
     *         are still active at that old block. If they're still active, it reports them to Staking Router.
     * @dev The oldBlock.header must have slot >= FIRST_SUPPORTED_SLOT.
     * @param exitRequests The concatenated VEBO exit requests, each 64 bytes in length.
     * @param beaconBlock The block header and EIP-4788 timestamp to prove the block root is known.
     * @param oldBlock Historical block header witness data and its proof.
     * @param validatorWitnesses Array of validator proofs to confirm they are not yet exited in oldBlock.header.
     */
    function verifyHistoricalActiveValidatorsAfterExitRequest(
        bytes calldata exitRequests,
        ProvableBeaconBlockHeader calldata beaconBlock,
        HistoricalHeaderWitness calldata oldBlock,
        ValidatorWitness[] calldata validatorWitnesses
    ) external {
        _verifyBeaconBlockRoot(beaconBlock);

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

        RequestStatus memory requestStatus = _verifyRequestStatus(exitRequests);

        for (uint256 i = 0; i < validatorWitnesses.length; i++) {
            (bytes calldata pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) = exitRequests
                .unpackExitRequest(validatorWitnesses[i].exitRequestIndex);

            uint64 secondsSinceEligibleExitRequest = _getSecondsSinceExitRequestEligible(
                requestStatus.getValidatorExitRequestTimestamp(validatorWitnesses[i].exitRequestIndex),
                oldBlock.header.slot,
                validatorWitnesses[i].activationEpoch
            );

            _verifyValidatorIsNotExited(oldBlock.header, validatorWitnesses[i], pubkey, valIndex);

            IStakingRouter(LOCATOR.stakingRouter()).reportUnexitedValidator(
                moduleId,
                nodeOpId,
                pubkey,
                secondsSinceEligibleExitRequest
            );
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

        // Sanity check. Ensure the chain-time configuration is consistent with the block slot
        // if (
        //     beaconBlock.rootsTimestamp < (GENESIS_TIME + beaconBlock.header.slot.unwrap() * SECONDS_PER_SLOT) ||
        //     beaconBlock.rootsTimestamp > (GENESIS_TIME + (beaconBlock.header.slot.unwrap() + 1) * SECONDS_PER_SLOT)
        // ) {
        //     revert ChainTimeConfigurationMismatch();
        // }
    }

    /**
     * @dev Verifies that a validator is still active (exitEpoch == FAR_FUTURE_EPOCH) and proves it against the state root.
     */
    function _verifyValidatorIsNotExited(
        BeaconBlockHeader calldata header,
        ValidatorWitness calldata witness,
        bytes calldata pubkey,
        uint256 validatorIndex
    ) internal view {
        if (witness.exitEpoch != FAR_FUTURE_EPOCH) {
            revert ValidatorAlreadyRequestedExit(pubkey, validatorIndex);
        }

        Validator memory validator = Validator({
            pubkey: pubkey,
            withdrawalCredentials: witness.withdrawalCredentials,
            effectiveBalance: witness.effectiveBalance,
            slashed: witness.slashed,
            activationEligibilityEpoch: witness.activationEligibilityEpoch,
            activationEpoch: witness.activationEpoch,
            exitEpoch: witness.exitEpoch,
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
     * @dev Determines how many seconds have passed since a validator was first eligible to exit after ValidatorsExitBusOracle exit request.
     * @param validatorExitRequestTimestamp The timestamp when the validator's exit request was submitted.
     * @param referenceSlot A reference slot, used to measure the elapsed duration since the validator became eligible to exit.
     * @param validatorActivationEpoch The epoch in which the validator was activated.
     * @return uint64 The elapsed seconds since the earliest eligible exit request time.
     */
    function _getSecondsSinceExitRequestEligible(
        uint64 validatorExitRequestTimestamp,
        Slot referenceSlot,
        uint64 validatorActivationEpoch
    ) internal view returns (uint64) {
        // The earliest a validator can voluntarily exit is after the Shard Committee Period
        // subsequent to its activation epoch.
        uint64 earliestPossibleVoluntaryExitTimestamp = GENESIS_TIME +
            (validatorActivationEpoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT) +
            SHARD_COMMITTEE_PERIOD_IN_SECONDS;

        // The actual eligible timestamp is the max between the exit request submission time
        // and the earliest possible voluntary exit time.
        uint64 eligibleExitRequestTimestamp = validatorExitRequestTimestamp > earliestPossibleVoluntaryExitTimestamp
            ? validatorExitRequestTimestamp
            : earliestPossibleVoluntaryExitTimestamp;

        uint64 referenceTimestamp = GENESIS_TIME + referenceSlot.unwrap() * SECONDS_PER_SLOT;

        if (referenceTimestamp < eligibleExitRequestTimestamp) {
            revert ExitRequestNotEligibleOnProvableBeaconBlock(referenceTimestamp, eligibleExitRequestTimestamp);
        }

        return referenceTimestamp - eligibleExitRequestTimestamp;
    }

    /**
     * @dev Retrieves the status of the provided exit requests from the ValidatorsExitBusOracle,
     *      and performs consistency checks against the data.
     */
    function _verifyRequestStatus(
        bytes calldata exitRequests
    ) internal view returns (RequestStatus memory requestStatus) {
        bytes32 exitRequestsHash = keccak256(exitRequests);
        requestStatus = IValidatorsExitBusOracle(LOCATOR.validatorsExitBusOracle()).getExitRequestsStatus(
            exitRequestsHash
        );

        // ToDo: move this check to the oracle getExitRequestsStatus method
        // error ExitRequestsNotFound(bytes32 exitRequestsHash);
        // if (requestStatus.contractVersion == 0) {
        //     revert ExitRequestsNotFound(exitRequestsHash);
        // }

        ExitRequests.verifyDataFormat(requestStatus.reportDataFormat);

        // Sanity check. Verify that the number of exit requests matches the oracle's record
        uint256 exitRequestsCount = exitRequests.count();
        if (exitRequestsCount != requestStatus.totalItemsCount) {
            revert ExitRequestsCountMismatch(exitRequestsCount, requestStatus.totalItemsCount);
        }
    }

    function _getValidatorGI(uint256 offset, Slot stateSlot) internal view returns (GIndex) {
        GIndex gI = stateSlot < PIVOT_SLOT ? GI_FIRST_VALIDATOR_PREV : GI_FIRST_VALIDATOR_CURR;
        return gI.shr(offset);
    }

    function _getHistoricalSummariesGI(Slot stateSlot) internal view returns (GIndex) {
        return stateSlot < PIVOT_SLOT ? GI_HISTORICAL_SUMMARIES_PREV : GI_HISTORICAL_SUMMARIES_CURR;
    }
}

/**
 * @notice Library for fetching validator exit request timestamps from a RequestStatus struct.
 */
library ExitRequestStatus {
    error KeyWasNotUnpacked(uint256 keyIndex, uint256 lastUnpackedKeyIndex);
    error KeyIndexOutOfRange(uint256 keyIndex, uint256 totalItemsCount);

    /**
     * @dev Retrieves the block timestamp at which a particular key (i.e., exit request) was delivered.
     * @param requestStatus The RequestStatus struct containing delivery history.
     * @param keyIndex The index of the exit request to look up.
     * @return validatorExitRequestTimestamp The timestamp when this key was delivered.
     */
    function getValidatorExitRequestTimestamp(
        RequestStatus memory requestStatus,
        uint256 keyIndex
    ) internal pure returns (uint64 validatorExitRequestTimestamp) {
        if (keyIndex >= requestStatus.totalItemsCount) {
            revert KeyIndexOutOfRange(keyIndex, requestStatus.totalItemsCount);
        }

        if (keyIndex > requestStatus.deliveredItemsCount - 1) {
            revert KeyWasNotUnpacked(keyIndex, requestStatus.deliveredItemsCount - 1);
        }

        for (uint256 i = 0; i < requestStatus.deliveryHistory.length; i++) {
            if (requestStatus.deliveryHistory[i].lastDeliveredKeyIndex >= keyIndex) {
                return requestStatus.deliveryHistory[i].timestamp;
            }
        }

        // As the loop should always end prematurely with the `return` statement,
        // this code should be unreachable. We assert `false` just to be safe.
        assert(false);
    }
}

/**
 * @notice Library for unpacking validator exit request data.
 */
library ExitRequests {
    // The data format version supported by this library
    uint256 internal constant SUPPORTED_DATA_FORMAT = 1;

    uint256 internal constant PACKED_REQUEST_LENGTH = 64;
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    error UnsupportedReportDataFormat(uint256 reportDataFormat);
    error ExitRequestIndexOutOfRange(uint256 exitRequestIndex);

    /**
     * @dev Unpacks a single exit request from a batch of exit requests.
     * @param exitRequests The concatenated exit requests data.
     * @param exitRequestIndex The index of the request to extract from the batch.
     */
    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 exitRequestIndex
    ) internal pure returns (bytes calldata pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) {
        if (exitRequestIndex >= count(exitRequests)) {
            revert ExitRequestIndexOutOfRange(exitRequestIndex);
        }

        uint256 itemOffset;
        uint256 dataWithoutPubkey;

        assembly {
            // Compute the start of the selected item
            itemOffset := add(exitRequests.offset, mul(PACKED_REQUEST_LENGTH, exitRequestIndex))

            // Load the first 16 bytes (moduleId, nodeOpId, part of valIndex)
            dataWithoutPubkey := shr(128, calldataload(itemOffset))

            // The next 48 bytes are the validator's public key
            pubkey.length := PUBLIC_KEY_LENGTH
            pubkey.offset := add(itemOffset, 16)
        }

        //                              dataWithoutPubkey
        // MSB <---------------------------------------------------------------------- LSB
        // | 128 bits: zeros | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |
        valIndex = uint64(dataWithoutPubkey);
        nodeOpId = uint40(dataWithoutPubkey >> 64);
        moduleId = uint24(dataWithoutPubkey >> (64 + 40));

        return (pubkey, nodeOpId, moduleId, valIndex);
    }

    /**
     * @dev Counts how many exit requests are packed in the given calldata array.
     */
    function count(bytes calldata exitRequests) internal pure returns (uint256) {
        return exitRequests.length / PACKED_REQUEST_LENGTH;
    }

    function verifyDataFormat(uint256 dataFormat) internal pure {
        if (dataFormat != SUPPORTED_DATA_FORMAT) {
            revert UnsupportedReportDataFormat(dataFormat);
        }
    }
}
