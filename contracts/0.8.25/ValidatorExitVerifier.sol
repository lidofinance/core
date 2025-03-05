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
    // VEBO report item index
    uint32 exitRequestIndex;
    // ── Validator fields ──
    uint64 validatorIndex;
    bytes32 withdrawalCredentials;
    uint64 effectiveBalance;
    bool slashed;
    uint64 activationEligibilityEpoch;
    uint64 activationEpoch;
    uint64 exitEpoch;
    uint64 withdrawableEpoch;
    // ── Proof ──
    bytes32[] validatorProof;
}

struct ProvableBeaconBlockHeader {
    BeaconBlockHeader header; // Header of a block which root is a root at rootsTimestamp.
    uint64 rootsTimestamp; // To be passed to the EIP-4788 block roots contract.
}

// A witness for a block header which root is accessible via `historical_summaries` field.
struct HistoricalHeaderWitness {
    BeaconBlockHeader header;
    GIndex rootGIndex;
    bytes32[] proof;
}

contract ValidatorExitVerifier {
    using SSZ for Validator;
    using SSZ for BeaconBlockHeader;
    using ExitRequestStatus for RequestStatus;
    using ExitRequests for bytes;

    uint64 constant FAR_FUTURE_EPOCH = type(uint64).max;

    uint32 public immutable SHARD_COMMITTEE_PERIOD_IN_SECONDS;
    uint32 public immutable SLOTS_PER_EPOCH;
    uint32 public immutable SECONDS_PER_SLOT;
    uint64 public immutable GENESIS_TIME;

    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    /// @dev This index is relative to a state like: `BeaconState.validators[0]`.
    GIndex public immutable GI_FIRST_VALIDATOR_PREV;

    /// @dev This index is relative to a state like: `BeaconState.validators[0]`.
    GIndex public immutable GI_FIRST_VALIDATOR_CURR;

    /// @dev This index is relative to a state like: `BeaconState.historical_summaries`.
    GIndex public immutable GI_HISTORICAL_SUMMARIES_PREV;

    /// @dev This index is relative to a state like: `BeaconState.historical_summaries`.
    GIndex public immutable GI_HISTORICAL_SUMMARIES_CURR;

    /// @dev The very first slot the verifier is supposed to accept proofs for.
    Slot public immutable FIRST_SUPPORTED_SLOT;

    /// @dev The first slot of the currently compatible fork.
    Slot public immutable PIVOT_SLOT;

    ILidoLocator public immutable LOCATOR;

    error RootNotFound();
    error InvalidGIndex();
    error InvalidBlockHeader();
    error UnsupportedSlot(Slot slot);
    error InvalidPivotSlot();
    error ZeroLidoLocatorAddress();
    error ExitRequestsNotFound(bytes32 exitRequestsHash);
    error UnsupportedReportDataFormat(uint256 reportDataFormat);
    error ExitRequestNotEligibleOnProvableBeaconBlock(
        uint64 provableBeaconBlockTimestamp,
        uint64 eligibleExitRequestTimestamp
    );
    error ValidatorAlreadyRequestedExit(uint256 validatorIndex);
    error ExitRequestsCountMismatch(uint256 exitRequestsCount, uint256 exitRequestsCountInExitReportStatus);
    error ChainTimeConfigurationMismatch();

    /// @dev The previous and current forks can be essentially the same.
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

    function verifyActiveValidatorsAfterExitRequest(
        bytes calldata exitRequests,
        ProvableBeaconBlockHeader calldata beaconBlock,
        ValidatorWitness[] calldata validatorWitnesses
    ) external {
        _verifyBeaconBlockRoot(beaconBlock);
        RequestStatus memory requestStatus = _verifyRequestStatus(exitRequests);

        for (uint256 i = 0; i < validatorWitnesses.length; i++) {
            (bytes calldata pubkey, uint256 nodeOpId, uint256 moduleId) = exitRequests.unpackExitRequest(
                validatorWitnesses[i].exitRequestIndex
            );

            uint64 secondsSinceEligibleExitRequest = _getSecondsSinceExitRequestEligible(
                requestStatus.getValidatorExitRequestTimestamp(validatorWitnesses[i].exitRequestIndex),
                beaconBlock.rootsTimestamp,
                validatorWitnesses[i].activationEpoch
            );

            _verifyValidatorIsActive(beaconBlock.header, validatorWitnesses[i], pubkey);

            IStakingRouter(LOCATOR.stakingRouter()).reportUnexitedValidator(
                moduleId,
                nodeOpId,
                pubkey,
                secondsSinceEligibleExitRequest
            );
        }
    }

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

        // It's up to a user to provide a valid generalized index of a historical block root in a summaries list.
        // Ensuring the provided generalized index is for a node somewhere below the historical_summaries root.
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
            (bytes calldata pubkey, uint256 nodeOpId, uint256 moduleId) = exitRequests.unpackExitRequest(
                validatorWitnesses[i].exitRequestIndex
            );

            uint64 secondsSinceEligibleExitRequest = _getSecondsSinceExitRequestEligible(
                requestStatus.getValidatorExitRequestTimestamp(validatorWitnesses[i].exitRequestIndex),
                GENESIS_TIME + oldBlock.header.slot.unwrap() * SECONDS_PER_SLOT,
                validatorWitnesses[i].activationEpoch
            );

            _verifyValidatorIsActive(oldBlock.header, validatorWitnesses[i], pubkey);

            IStakingRouter(LOCATOR.stakingRouter()).reportUnexitedValidator(
                moduleId,
                nodeOpId,
                pubkey,
                secondsSinceEligibleExitRequest
            );
        }
    }

    /// @notice Verify withdrawal proof
    /// @param header Beacon block header
    function _verifyValidatorIsActive(
        BeaconBlockHeader calldata header,
        ValidatorWitness calldata witness,
        bytes calldata pubkey
    ) internal view {
        if (witness.exitEpoch != FAR_FUTURE_EPOCH) {
            revert ValidatorAlreadyRequestedExit(witness.validatorIndex);
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
            gI: _getValidatorGI(witness.validatorIndex, header.slot)
        });
    }

    /**
     * @dev Verifies a beacon block is trustworthy via EIP-4788 contract.
     */
    function _verifyBeaconBlockRoot(ProvableBeaconBlockHeader calldata beaconBlock) internal view {
        if (beaconBlock.header.slot < FIRST_SUPPORTED_SLOT) {
            revert UnsupportedSlot(beaconBlock.header.slot);
        }

        // Check EIP-4788 for known block root
        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(beaconBlock.rootsTimestamp));

        if (!success || data.length == 0) {
            revert RootNotFound();
        }

        bytes32 trustedRoot = abi.decode(data, (bytes32));
        if (trustedRoot != beaconBlock.header.hashTreeRoot()) {
            revert InvalidBlockHeader();
        }

        // Perform simple sanity checks to make sure that provided GENESIS_TIME & SECONDS_PER_SLOT consistent
        // against EIP-4788 contract data.
        if (
            beaconBlock.rootsTimestamp < GENESIS_TIME + beaconBlock.header.slot.unwrap() * SECONDS_PER_SLOT ||
            beaconBlock.rootsTimestamp > GENESIS_TIME + (beaconBlock.header.slot.unwrap() + 1) * SECONDS_PER_SLOT
        ) {
            revert ChainTimeConfigurationMismatch();
        }
    }

    function _getValidatorGI(uint256 offset, Slot stateSlot) internal view returns (GIndex) {
        GIndex gI = stateSlot < PIVOT_SLOT ? GI_FIRST_VALIDATOR_PREV : GI_FIRST_VALIDATOR_CURR;
        return gI.shr(offset);
    }

    function _getHistoricalSummariesGI(Slot stateSlot) internal view returns (GIndex) {
        return stateSlot < PIVOT_SLOT ? GI_HISTORICAL_SUMMARIES_PREV : GI_HISTORICAL_SUMMARIES_CURR;
    }

    function _getSecondsSinceExitRequestEligible(
        uint64 validatorExitRequestTimestamp,
        uint64 provableBeaconBlockTimestamp,
        uint64 validatorActivationEpoch
    ) internal view returns (uint64) {
        uint64 earliestPossibleVoluntaryExitTimestamp = GENESIS_TIME +
            (validatorActivationEpoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT) +
            SHARD_COMMITTEE_PERIOD_IN_SECONDS;

        uint64 eligibleExitRequestTimestamp = validatorExitRequestTimestamp > earliestPossibleVoluntaryExitTimestamp
            ? validatorExitRequestTimestamp
            : earliestPossibleVoluntaryExitTimestamp;

        if (provableBeaconBlockTimestamp < eligibleExitRequestTimestamp) {
            revert ExitRequestNotEligibleOnProvableBeaconBlock(
                provableBeaconBlockTimestamp,
                eligibleExitRequestTimestamp
            );
        }

        return provableBeaconBlockTimestamp - eligibleExitRequestTimestamp;
    }

    function _verifyRequestStatus(
        bytes calldata exitRequests
    ) internal view returns (RequestStatus memory requestStatus) {
        bytes32 exitRequestsHash = keccak256(exitRequests);
        requestStatus = IValidatorsExitBusOracle(LOCATOR.validatorsExitBusOracle()).getExitRequestsStatus(
            exitRequestsHash
        );

        if (requestStatus.contractVersion == 0) {
            revert ExitRequestsNotFound(exitRequestsHash);
        }

        if (requestStatus.reportDataFormat != 1) {
            revert UnsupportedReportDataFormat(requestStatus.reportDataFormat);
        }

        // Perform simple sanity checks to make sure that provided exit requests data consistent.
        if (exitRequests.count() != requestStatus.totalItemsCount) {
            revert ExitRequestsCountMismatch(exitRequests.count(), requestStatus.totalItemsCount);
        }
    }
}

library ExitRequestStatus {
    error KeyWasNotUnpacked(uint256 keyIndex, uint256 lastUnpackedKeyIndex);
    error KeyIndexOutOfRange(uint256 keyIndex, uint256 totalItemsCount);

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
                return requestStatus.deliveryHistory[i].blockTimestamp;
            }
        }

        // As the loop should always end prematurely with the `return` statement,
        // this code should be unreachable. We assert `false` just to be safe.
        assert(false);
    }
}

library ExitRequests {
    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    error ExitRequestIndexOutOfRange(uint256 exitRequestIndex);

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 exitRequestIndex
    ) internal pure returns (bytes calldata pubkey, uint256 nodeOpId, uint256 moduleId) {
        if (exitRequestIndex >= count(exitRequests)) {
            revert ExitRequestIndexOutOfRange(exitRequestIndex);
        }

        uint256 itemOffset;
        uint256 dataWithoutPubkey;
        assembly {
            // Compute the start of the selected item
            itemOffset := add(exitRequests.offset, mul(PACKED_REQUEST_LENGTH, exitRequestIndex))

            // 16 most significant bytes are taken by module id, node op id, and val index
            dataWithoutPubkey := shr(128, calldataload(itemOffset))

            // Next 48 bytes are taken by the pubkey
            pubkey.length := PUBLIC_KEY_LENGTH
            pubkey.offset := add(itemOffset, 16)
        }

        //                              dataWithoutPubkey
        // MSB <---------------------------------------------------------------------- LSB
        // | 128 bits: zeros | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |

        nodeOpId = uint40(dataWithoutPubkey >> 64);
        moduleId = uint24(dataWithoutPubkey >> (64 + 40));

        return (pubkey, nodeOpId, moduleId);
    }

    function count(bytes calldata exitRequests) internal pure returns (uint256) {
        return exitRequests.length / PACKED_REQUEST_LENGTH;
    }
}
