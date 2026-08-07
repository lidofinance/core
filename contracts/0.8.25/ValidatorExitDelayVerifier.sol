// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {BeaconBlockHeader, Validator} from "contracts/common/lib/BeaconTypes.sol";
import {GIndex, pack, progressiveListNodeGIndex} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";

interface ILidoLocator {
    function stakingRouter() external view returns(address);
    function validatorsExitBusOracle() external view returns(address);
}

interface IStakingRouter {
    function reportValidatorExitDelay(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) external;
}

interface IValidatorsExitBus {
    function getDeliveryTimestamp(bytes32 exitRequestsHash) external view returns (uint256 deliveryDateTimestamp);

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external pure returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex);
}

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
    bytes32[] proof; // The Merkle proof for the old block header against the state's historical_summaries root.
}

// A witness for a block header whose root is accessible via the `block_roots` field.
struct BlockRootsHeaderWitness {
    BeaconBlockHeader header;
    bytes32[] proof;
}

struct GIndices {
    GIndex gIFirstValidatorPreGloas;
    GIndex gIValidators;
    GIndex gIFirstHistoricalSummaryPrev;
    GIndex gIFirstHistoricalSummaryCurr;
    GIndex gIFirstBlockRootInSummaryPrev;
    GIndex gIFirstBlockRootInSummaryCurr;
    GIndex gIBlockRootsPreGloas;
    GIndex gIBlockRoots;
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

    /// @dev This index is relative to a state like: `BeaconState.validators[0]`.
    GIndex public immutable GI_FIRST_VALIDATOR_PRE_GLOAS;

    /// @dev This index is relative to a Gloas state like: `BeaconState.validators`.
    GIndex public immutable GI_VALIDATORS;

    /// @dev This index is relative to a state like: `BeaconState.historical_summaries[0]`.
    GIndex public immutable GI_FIRST_HISTORICAL_SUMMARY_PREV;

    /// @dev This index is relative to a state like: `BeaconState.historical_summaries[0]`.
    GIndex public immutable GI_FIRST_HISTORICAL_SUMMARY_CURR;

    /// @dev This index is relative to HistoricalSummary like: HistoricalSummary.blockRoots[0].
    GIndex public immutable GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV;

    /// @dev This index is relative to HistoricalSummary like: HistoricalSummary.blockRoots[0].
    GIndex public immutable GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR;

    /// @dev This index is relative to a pre-Gloas state like: `BeaconState.block_roots`.
    GIndex public immutable GI_BLOCK_ROOTS_PRE_GLOAS;

    /// @dev This index is relative to a Gloas state like: `BeaconState.block_roots`.
    GIndex public immutable GI_BLOCK_ROOTS;

    /// @notice The first slot this verifier will accept proofs for.
    uint64 public immutable FIRST_SUPPORTED_SLOT;

    /// @notice The first slot of the currently-compatible fork.
    uint64 public immutable PIVOT_SLOT;

    /// @notice The slot where Capella fork started (when historical summaries became available).
    uint64 public immutable CAPELLA_SLOT;

    /// @notice Count of historical roots per accumulator.
    /// @dev See https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#time-parameters
    uint64 public immutable SLOTS_PER_HISTORICAL_ROOT;

    ILidoLocator public immutable LOCATOR;

    error RootNotFound();
    error InvalidGIndex();
    error InvalidBlockHeader();
    error UnsupportedSlot(uint64 slot);
    error InvalidPivotSlot();
    error InvalidPerHistoricalRootSlot();
    error ZeroLidoLocatorAddress();
    error ExitIsNotEligibleOnProvableBeaconBlock(
        uint256 provableBeaconBlockTimestamp,
        uint256 eligibleExitRequestTimestamp
    );
    error InvalidCapellaSlot();
    error HistoricalSummaryDoesNotExist();
    error BlockRootNotInRange();

    /**
     * @dev The previous and current forks can be essentially the same.
     * @param lidoLocator The address of the LidoLocator contract.
     * @param gIndices Struct containing all GIndices for the contract.
     * @param firstSupportedSlot The earliest slot number that proofs can be submitted for verification.
     * @param pivotSlot The pivot slot number used to differentiate "previous" vs "current" fork indexing.
     * @param capellaSlot The slot where Capella fork started.
     * @param slotsPerHistoricalRoot Number of slots per historical root.
     * @param slotsPerEpoch Number of slots per epoch in Ethereum consensus.
     * @param secondsPerSlot Duration of a single slot, in seconds, in Ethereum consensus.
     * @param genesisTime Genesis timestamp of the Ethereum Beacon chain.
     * @param shardCommitteePeriodInSeconds The length of the shard committee period, in seconds.
     */
    constructor(
        address lidoLocator,
        GIndices memory gIndices,
        uint64 firstSupportedSlot,
        uint64 pivotSlot,
        uint64 capellaSlot,
        uint64 slotsPerHistoricalRoot,
        uint32 slotsPerEpoch,
        uint32 secondsPerSlot,
        uint64 genesisTime,
        uint32 shardCommitteePeriodInSeconds
    ) {
        if (lidoLocator == address(0)) revert ZeroLidoLocatorAddress();
        if (firstSupportedSlot > pivotSlot) revert InvalidPivotSlot();
        if (capellaSlot > firstSupportedSlot) revert InvalidCapellaSlot();
        if (slotsPerHistoricalRoot == 0) revert InvalidPerHistoricalRootSlot();

        LOCATOR = ILidoLocator(lidoLocator);

        // Assign individual GIndex values from the struct
        GI_FIRST_VALIDATOR_PRE_GLOAS = gIndices.gIFirstValidatorPreGloas;
        GI_VALIDATORS = gIndices.gIValidators;
        GI_FIRST_HISTORICAL_SUMMARY_PREV = gIndices.gIFirstHistoricalSummaryPrev;
        GI_FIRST_HISTORICAL_SUMMARY_CURR = gIndices.gIFirstHistoricalSummaryCurr;
        GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV = gIndices.gIFirstBlockRootInSummaryPrev;
        GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR = gIndices.gIFirstBlockRootInSummaryCurr;
        GI_BLOCK_ROOTS_PRE_GLOAS = gIndices.gIBlockRootsPreGloas;
        GI_BLOCK_ROOTS = gIndices.gIBlockRoots;

        FIRST_SUPPORTED_SLOT = firstSupportedSlot;
        PIVOT_SLOT = pivotSlot;
        CAPELLA_SLOT = capellaSlot;
        SLOTS_PER_HISTORICAL_ROOT = slotsPerHistoricalRoot;
        SLOTS_PER_EPOCH = slotsPerEpoch;
        SECONDS_PER_SLOT = secondsPerSlot;
        GENESIS_TIME = genesisTime;
        SHARD_COMMITTEE_PERIOD_IN_SECONDS = shardCommitteePeriodInSeconds;
    }

    // ------------------------- External Functions -------------------------

    /**
     * @notice Verifies that the provided validators were not requested to exit on the CL after a VEB exit request.
     *         Reports exit delays to the Staking Router.
     * @dev Ensures that `exitEpoch` is equal to `FAR_FUTURE_EPOCH` at the target block.
     * @param recentBlock The recent block header anchored through EIP-4788.
     * @param targetBlock The target block header and its proof against recentBlock.header.stateRoot.
     * @param validatorWitnesses Array of validator proofs against targetBlock.header.stateRoot.
     * @param exitRequests The concatenated VEBO exit requests, each 64 bytes in length.
     */
    function verifyValidatorExitDelay(
        ProvableBeaconBlockHeader calldata recentBlock,
        BlockRootsHeaderWitness calldata targetBlock,
        ValidatorWitness[] calldata validatorWitnesses,
        ExitRequestData calldata exitRequests
    ) external {
        _verifyBeaconBlockRoot(recentBlock);
        _verifyBlockRootsBeaconBlockRoot(recentBlock, targetBlock);
        _reportValidatorExitDelays(targetBlock.header, validatorWitnesses, exitRequests);
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
        _reportValidatorExitDelays(oldBlock.header, validatorWitnesses, exitRequests);
    }

    function _reportValidatorExitDelays(
        BeaconBlockHeader calldata header,
        ValidatorWitness[] calldata validatorWitnesses,
        ExitRequestData calldata exitRequests
    ) internal {
        IValidatorsExitBus veb = IValidatorsExitBus(LOCATOR.validatorsExitBusOracle());
        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());

        uint256 deliveredTimestamp = _getExitRequestDeliveryTimestamp(veb, exitRequests);
        uint256 proofSlotTimestamp = _slotToTimestamp(header.slot);

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

            _verifyValidatorExitUnset(header, witness, pubkey, valIndex);

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

        SSZ.verifyProof({
            proof: oldBlock.proof,
            root: beaconBlock.header.stateRoot,
            leaf: oldBlock.header.hashTreeRoot(),
            gI: _getHistoricalBlockRootGI(beaconBlock.header.slot, oldBlock.header.slot)
        });
    }

    function _verifyBlockRootsBeaconBlockRoot(
        ProvableBeaconBlockHeader calldata recentBlock,
        BlockRootsHeaderWitness calldata targetBlock
    ) internal view {
        if (targetBlock.header.slot < FIRST_SUPPORTED_SLOT) {
            revert UnsupportedSlot(targetBlock.header.slot);
        }

        SSZ.verifyProof({
            proof: targetBlock.proof,
            root: recentBlock.header.stateRoot,
            leaf: targetBlock.header.hashTreeRoot(),
            gI: _getBlockRootsBlockGI(recentBlock.header.slot, targetBlock.header.slot)
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

        if (referenceSlotTimestamp <= eligibleExitRequestTimestamp) {
            revert ExitIsNotEligibleOnProvableBeaconBlock(referenceSlotTimestamp, eligibleExitRequestTimestamp);
        }

        return referenceSlotTimestamp - eligibleExitRequestTimestamp;
    }

    function _getValidatorGI(uint256 offset, uint64 stateSlot) internal view returns (GIndex) {
        if (stateSlot < PIVOT_SLOT) {
            return GI_FIRST_VALIDATOR_PRE_GLOAS.shr(offset);
        }
        return GI_VALIDATORS.concat(progressiveListNodeGIndex(offset));
    }

    function _getHistoricalBlockRootGI(
        uint64 recentSlot,
        uint64 targetSlot
    ) internal view returns (GIndex gI) {
        uint64 targetSlotShifted = targetSlot - CAPELLA_SLOT;
        uint64 summaryIndex = targetSlotShifted / SLOTS_PER_HISTORICAL_ROOT;
        uint64 rootIndex = targetSlot % SLOTS_PER_HISTORICAL_ROOT;

        uint64 summaryCreatedAtSlot = targetSlot - rootIndex + SLOTS_PER_HISTORICAL_ROOT;
        if (summaryCreatedAtSlot > recentSlot) {
            revert HistoricalSummaryDoesNotExist();
        }

        gI = recentSlot < PIVOT_SLOT
            ? GI_FIRST_HISTORICAL_SUMMARY_PREV
            : GI_FIRST_HISTORICAL_SUMMARY_CURR;

        gI = gI.shr(summaryIndex); // historicalSummaries[summaryIndex]
        gI = gI.concat(
            summaryCreatedAtSlot < PIVOT_SLOT
                ? GI_FIRST_BLOCK_ROOT_IN_SUMMARY_PREV
                : GI_FIRST_BLOCK_ROOT_IN_SUMMARY_CURR
        ); // historicalSummaries[summaryIndex].blockRoots[0]
        gI = gI.shr(rootIndex); // historicalSummaries[summaryIndex].blockRoots[rootIndex]
    }

    /// @dev Generalized index of `targetSlot` in the `recentSlot` state `block_roots` ring.
    function _getBlockRootsBlockGI(uint64 recentSlot, uint64 targetSlot) internal view returns (GIndex gI) {
        // The post-state contains roots for [recentSlot - SLOTS_PER_HISTORICAL_ROOT, recentSlot - 1].
        if (targetSlot >= recentSlot || recentSlot - targetSlot > SLOTS_PER_HISTORICAL_ROOT) {
            revert BlockRootNotInRange();
        }

        uint64 rootIndex = targetSlot % SLOTS_PER_HISTORICAL_ROOT;
        gI = recentSlot < PIVOT_SLOT ? GI_BLOCK_ROOTS_PRE_GLOAS : GI_BLOCK_ROOTS;
        gI = gI.concat(pack(SLOTS_PER_HISTORICAL_ROOT | rootIndex, 0));
    }

    function _getExitRequestDeliveryTimestamp(
        IValidatorsExitBus veb,
        ExitRequestData calldata exitRequests
    ) internal view returns (uint256 deliveryTimestamp) {
        bytes32 exitRequestsHash = keccak256(abi.encode(exitRequests.data, exitRequests.dataFormat));
        deliveryTimestamp = veb.getDeliveryTimestamp(exitRequestsHash);
    }

    function _slotToTimestamp(uint64 slot) internal view returns (uint256) {
        return GENESIS_TIME + slot * SECONDS_PER_SLOT;
    }
}
