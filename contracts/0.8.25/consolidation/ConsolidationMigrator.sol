// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

/**
 * @dev Minimal interface for StakingRouter to get module addresses
 */
interface IStakingRouter {
    struct StakingModule {
        uint24 id;
        address stakingModuleAddress;
        uint16 stakingModuleFee;
        uint16 treasuryFee;
        uint16 stakeShareLimit;
        uint8 status;
        string name;
        uint64 lastDepositAt;
        uint256 lastDepositBlock;
        uint256 exitedValidatorsCount;
        uint16 priorityExitShareThreshold;
        uint64 maxDepositsPerBlock;
        uint64 minDepositBlockDistance;
        uint8 withdrawalCredentialsType;
    }

    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory);
}

/**
 * @dev Unified interface for staking modules (NOR, SDVT, CMv1, CMv2)
 *      It also works for legacy staking modules (NOR, SDVT) where `getSigningKeys` returns different
 *      tuple `(bytes memory pubkeys, bytes memory signatures, bool[] memory used)`.
 *      The trick: `abi.decode(returndata, (bytes))` will decode only the first tuple element.
 *      This is safe as long as the first returned value really is `bytes pubkeys` in that position.
 */
interface IUnifiedStakingModule {
    function getSigningKeys(
        uint256 nodeOperatorId,
        uint256 startIndex,
        uint256 keysCount
    ) external view returns (bytes memory);

    function getNodeOperatorSummary(
        uint256 _nodeOperatorId
    )
        external
        view
        returns (
            uint256 targetLimitMode,
            uint256 targetValidatorsCount,
            uint256 stuckValidatorsCount,
            uint256 refundedValidatorsCount,
            uint256 stuckPenaltyEndTimestamp,
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        );
}

/**
 * @dev Interface for ConsolidationBus to submit consolidation requests
 */
interface IConsolidationBus {
    function addConsolidationRequests(bytes[][] calldata sourcePubkeysGroups, bytes[] calldata targetPubkeys) external;
}

/**
 * @title ConsolidationMigrator
 * @notice Validates and submits consolidation requests from source module to target module.
 *
 * The workflow:
 * 1. Allows the consolidation manager to submit consolidation requests for operator pairs
 * 2. Consolidation manager submit consolidation batches
 * 3. Contract validates keys and forwards to ConsolidationBus
 */
contract ConsolidationMigrator is AccessControlEnumerable {
    using EnumerableSet for EnumerableSet.UintSet;

    // ==========
    //  Errors
    // ==========

    error ZeroArgument(string name);
    error AdminCannotBeZero();
    error PairNotInAllowlist(uint256 sourceOperatorId, uint256 targetOperatorId);
    error ArraysLengthMismatch(uint256 sourceGroupsLength, uint256 targetLength);
    error KeyNotDeposited(uint256 moduleId, uint256 operatorId, uint256 keyIndex);
    error NotAuthorized(address caller, uint256 sourceOperatorId, uint256 targetOperatorId);

    // ==========
    //  Events
    // ==========

    event ConsolidationPairAllowed(
        uint256 indexed sourceOperatorId,
        uint256 indexed targetOperatorId,
        address indexed submitter
    );
    event ConsolidationPairDisallowed(uint256 indexed sourceOperatorId, uint256 indexed targetOperatorId);
    event ConsolidationSubmitted(
        uint256 indexed sourceOperatorId,
        uint256 indexed targetOperatorId,
        uint256[][] sourceKeyIndicesGroups,
        uint256[] targetKeyIndices
    );

    // ==========
    //  Roles
    // ==========

    bytes32 public constant ALLOW_PAIR_ROLE = keccak256("ALLOW_PAIR_ROLE");
    bytes32 public constant DISALLOW_PAIR_ROLE = keccak256("DISALLOW_PAIR_ROLE");

    // ==========
    //  Immutables
    // ==========

    uint256 public constant PUBKEY_LENGTH = 48;

    IStakingRouter internal immutable STAKING_ROUTER;
    IConsolidationBus internal immutable CONSOLIDATION_BUS;
    uint256 internal immutable SOURCE_MODULE_ID;
    uint256 internal immutable TARGET_MODULE_ID;

    // ==========
    //  Storage
    // ==========

    /// @dev mapping(sourceOperatorId => set of allowed targetOperatorIds)
    mapping(uint256 => EnumerableSet.UintSet) internal _allowedPairs;

    /// @dev mapping(sourceOperatorId => mapping(targetOperatorId => submitter address))
    mapping(uint256 => mapping(uint256 => address)) internal _submitters;

    // ==========
    //  Constructor
    // ==========

    constructor(
        address admin,
        address stakingRouter,
        address consolidationBus,
        uint256 _sourceModuleId,
        uint256 _targetModuleId
    ) {
        if (admin == address(0)) revert AdminCannotBeZero();
        if (stakingRouter == address(0)) revert ZeroArgument("stakingRouter");
        if (consolidationBus == address(0)) revert ZeroArgument("consolidationBus");
        if (_sourceModuleId == 0) revert ZeroArgument("sourceModuleId");
        if (_targetModuleId == 0) revert ZeroArgument("targetModuleId");

        STAKING_ROUTER = IStakingRouter(stakingRouter);
        CONSOLIDATION_BUS = IConsolidationBus(consolidationBus);
        SOURCE_MODULE_ID = _sourceModuleId;
        TARGET_MODULE_ID = _targetModuleId;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ======================
    //  Allowlist Management
    // ======================

    /**
     * @notice Allows a consolidation pair (source operator -> target operator) with a designated submitter
     * @param sourceOperatorId ID of the source operator in source module
     * @param targetOperatorId ID of the target operator in target module
     * @param submitter Address authorized to submit consolidation batches for this pair
     * @dev Can be called multiple times to update the submitter for an existing pair
     * @dev Reverts if caller does not have ALLOW_PAIR_ROLE or if submitter is zero address
     */
    function allowPair(
        uint256 sourceOperatorId,
        uint256 targetOperatorId,
        address submitter
    ) external onlyRole(ALLOW_PAIR_ROLE) {
        if (submitter == address(0)) revert ZeroArgument("submitter");

        _allowedPairs[sourceOperatorId].add(targetOperatorId);
        _submitters[sourceOperatorId][targetOperatorId] = submitter;

        emit ConsolidationPairAllowed(sourceOperatorId, targetOperatorId, submitter);
    }

    /**
     * @notice Disallows a consolidation pair and removes the submitter
     * @param sourceOperatorId ID of the source operator
     * @param targetOperatorId ID of the target operator
     * @dev Reverts if caller does not have DISALLOW_PAIR_ROLE
     */
    function disallowPair(uint256 sourceOperatorId, uint256 targetOperatorId) external onlyRole(DISALLOW_PAIR_ROLE) {
        bool removed = _allowedPairs[sourceOperatorId].remove(targetOperatorId);
        if (!removed) revert PairNotInAllowlist(sourceOperatorId, targetOperatorId);

        delete _submitters[sourceOperatorId][targetOperatorId];

        emit ConsolidationPairDisallowed(sourceOperatorId, targetOperatorId);
    }

    // ==============
    //  View Methods
    // ==============

    /**
     * @notice Checks if a consolidation pair is allowed
     * @param sourceOperatorId ID of the source operator
     * @param targetOperatorId ID of the target operator
     * @return True if the pair is allowed
     */
    function isPairAllowed(uint256 sourceOperatorId, uint256 targetOperatorId) external view returns (bool) {
        return _allowedPairs[sourceOperatorId].contains(targetOperatorId);
    }

    /**
     * @notice Returns all allowed target operators for a given source operator
     * @param sourceOperatorId ID of the source operator
     * @return Array of allowed target operator IDs
     */
    function getAllowedTargets(uint256 sourceOperatorId) external view returns (uint256[] memory) {
        return _allowedPairs[sourceOperatorId].values();
    }

    /**
     * @notice Returns the submitter address for a consolidation pair
     * @param sourceOperatorId ID of the source operator
     * @param targetOperatorId ID of the target operator
     * @return Address authorized to submit consolidation batches, or address(0) if pair not allowed
     */
    function getSubmitter(uint256 sourceOperatorId, uint256 targetOperatorId) external view returns (address) {
        return _submitters[sourceOperatorId][targetOperatorId];
    }

    /**
     * @notice Returns the StakingRouter address
     * @return Address of the StakingRouter
     */
    function getStakingRouter() external view returns (address) {
        return address(STAKING_ROUTER);
    }

    /**
     * @notice Returns the ConsolidationBus address
     * @return Address of the ConsolidationBus
     */
    function getConsolidationBus() external view returns (address) {
        return address(CONSOLIDATION_BUS);
    }

    /**
     * @notice Returns the source module ID this migrator is bound to
     * @return Source module ID
     */
    function sourceModuleId() external view returns (uint256) {
        return SOURCE_MODULE_ID;
    }

    /**
     * @notice Returns the target module ID this migrator is bound to
     * @return Target module ID
     */
    function targetModuleId() external view returns (uint256) {
        return TARGET_MODULE_ID;
    }

    // ============
    //    Submit
    // ============

    /**
     * @notice Submits a consolidation batch after validation
     * @param sourceOperatorId ID of the source operator
     * @param targetOperatorId ID of the target operator
     * @param sourceKeyIndicesGroups Groups of source key indices, one group per target
     * @param targetKeyIndices Indices of target keys
     * @dev Caller must be the designated submitter for this pair (set via allowPair)
     * @dev Forwards the validated batch to ConsolidationBus
     */
    function submitConsolidationBatch(
        uint256 sourceOperatorId,
        uint256 targetOperatorId,
        uint256[][] calldata sourceKeyIndicesGroups,
        uint256[] calldata targetKeyIndices
    ) external {
        // Check authorization: caller must be the designated submitter for this pair
        address submitter = _submitters[sourceOperatorId][targetOperatorId];
        if (msg.sender != submitter) {
            revert NotAuthorized(msg.sender, sourceOperatorId, targetOperatorId);
        }

        if (sourceKeyIndicesGroups.length != targetKeyIndices.length) {
            revert ArraysLengthMismatch(sourceKeyIndicesGroups.length, targetKeyIndices.length);
        }

        // Validate the batch and get pubkeys
        (bytes[][] memory sourcePubkeysGroups, bytes[] memory targetPubkeys) = _getValidatedConsolidationPubkeys(
            sourceOperatorId,
            targetOperatorId,
            sourceKeyIndicesGroups,
            targetKeyIndices
        );

        CONSOLIDATION_BUS.addConsolidationRequests(sourcePubkeysGroups, targetPubkeys);

        emit ConsolidationSubmitted(sourceOperatorId, targetOperatorId, sourceKeyIndicesGroups, targetKeyIndices);
    }

    // ==================
    //  Internal Methods
    // ==================

    /**
     * @dev Validates consolidation key sets and returns corresponding pubkeys.
     *      Ensures all referenced keys are deposited.
     */
    function _getValidatedConsolidationPubkeys(
        uint256 sourceOperatorId,
        uint256 targetOperatorId,
        uint256[][] calldata sourceKeyIndicesGroups,
        uint256[] calldata targetKeyIndices
    ) internal view returns (bytes[][] memory sourcePubkeysGroups, bytes[] memory targetPubkeys) {
        uint256 groupsCount = targetKeyIndices.length;

        sourcePubkeysGroups = new bytes[][](groupsCount);
        for (uint256 i = 0; i < groupsCount; ++i) {
            sourcePubkeysGroups[i] = _validateAndExtractKeys(
                SOURCE_MODULE_ID,
                sourceOperatorId,
                sourceKeyIndicesGroups[i]
            );
        }

        targetPubkeys = _validateAndExtractKeys(TARGET_MODULE_ID, targetOperatorId, targetKeyIndices);

        return (sourcePubkeysGroups, targetPubkeys);
    }

    function _validateAndExtractKeys(
        uint256 moduleId,
        uint256 operatorId,
        uint256[] calldata keyIndices
    ) internal view returns (bytes[] memory pubkeys) {
        IUnifiedStakingModule module = _getModule(moduleId);

        (, , , , , , uint256 totalDeposited, ) = module.getNodeOperatorSummary(operatorId);

        uint256 count = keyIndices.length;
        pubkeys = new bytes[](count);

        for (uint256 i = 0; i < count; ++i) {
            uint256 keyIndex = keyIndices[i];

            if (keyIndex >= totalDeposited) {
                revert KeyNotDeposited(moduleId, operatorId, keyIndex);
            }

            bytes memory key = module.getSigningKeys(operatorId, keyIndex, 1);
            assert(key.length == PUBKEY_LENGTH); // Should always be 48 bytes for a single key
            pubkeys[i] = key;
        }
    }

    function _getModule(uint256 moduleId) internal view returns (IUnifiedStakingModule) {
        IStakingRouter.StakingModule memory sm = STAKING_ROUTER.getStakingModule(moduleId);
        return IUnifiedStakingModule(sm.stakingModuleAddress);
    }
}
