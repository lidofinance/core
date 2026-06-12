// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {TopUpData, BeaconRootData, ValidatorWitness} from "contracts/common/interfaces/TopUpWitness.sol";
import {CLValidatorVerifier} from "./CLValidatorVerifier.sol";
import {
    AccessControlEnumerableUpgradeable
} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {WithdrawalCredentials} from "contracts/common/lib/WithdrawalCredentials.sol";
import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";

interface ILidoLocator {
    function stakingRouter() external view returns (address);
}

interface IStakingRouter {
    function getStakingModuleWithdrawalCredentials(uint256 _stakingModuleId) external view returns (bytes32);
    function topUp(
        uint256 _stakingModuleId,
        uint256[] calldata _keyIndices,
        uint256[] calldata _operatorIds,
        bytes[] calldata _pubkeys,
        uint256[] calldata _topUpLimits
    ) external;
}

/**
 * @title TopUpGateway
 * @author Lido
 * @notice TopUpGateway is a contract that serves as the entry point for validator top-ups
 */
contract TopUpGateway is CLValidatorVerifier, AccessControlEnumerableUpgradeable, PausableUntil {
    using WithdrawalCredentials for bytes32;

    ILidoLocator internal immutable LOCATOR;

    struct Storage {
        uint64 maxValidatorsPerTopUp; // 64
        uint32 lastTopUpTimestamp; // 32
        uint32 lastTopUpBlock; // 32
        uint16 minBlockDistance; // 16
        uint16 maxRootAge; // 16
        uint64 targetBalanceGwei; // 64
        uint64 minTopUpGwei; // 64
    }

    /// @dev Storage slot: keccak256(abi.encode(uint256(keccak256("lido.TopUpGateway.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant GATEWAY_STORAGE_POSITION =
        0x22e512057841e2bc1e6d80030c8bb8b4935377af2e64ba9bf8e6a3e88fb32200;

    uint256 internal constant PUBKEY_LENGTH = 48;
    uint256 internal constant FAR_FUTURE_EPOCH = type(uint64).max;
    uint256 public immutable SLOTS_PER_EPOCH;

    bytes32 public constant TOP_UP_ROLE = keccak256("TOP_UP_ROLE");
    bytes32 public constant MANAGE_LIMITS_ROLE = keccak256("MANAGE_LIMITS_ROLE");
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");

    constructor(
        address _lidoLocator,
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        uint64 _pivotSlot,
        uint256 _slotsPerEpoch
    ) CLValidatorVerifier(_gIFirstValidatorPrev, _gIFirstValidatorCurr, _pivotSlot) {
        if (_lidoLocator == address(0)) revert ZeroArgument("_lidoLocator");
        LOCATOR = ILidoLocator(_lidoLocator);
        SLOTS_PER_EPOCH = _slotsPerEpoch;
        _disableInitializers();
    }

    /// @notice Initializes the TopUpGateway proxy with admin, rate limits, and top-up balance parameters.
    /// @param _admin Address to receive DEFAULT_ADMIN_ROLE
    /// @param _maxValidatorsPerTopUp Maximum number of validators per single topUp call
    /// @param _minTopUpBlockDistance Minimum blocks between topUp calls
    /// @param _maxRootAgeSec Maximum age (seconds) of beacon root relative to block.timestamp
    /// @param _targetBalanceGwei Target validator balance ceiling after top-up (in Gwei).
    ///        Top-up amount = targetBalance - currentTotal.
    /// @param _minTopUpGwei Minimum top-up that can be performed (in Gwei). If calculated top-up < minTopUp, returns 0.
    ///        Must be <= _targetBalanceGwei.
    function initialize(
        address _admin,
        uint256 _maxValidatorsPerTopUp,
        uint256 _minTopUpBlockDistance,
        uint256 _maxRootAgeSec,
        uint256 _targetBalanceGwei,
        uint256 _minTopUpGwei
    ) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _setMaxValidatorsPerTopUp(_maxValidatorsPerTopUp);
        _setMinBlockDistance(_minTopUpBlockDistance);
        _setMaxRootAge(_maxRootAgeSec);
        _setTopUpBalanceLimits(_targetBalanceGwei, _minTopUpGwei);
    }

    /**
     * @notice Resume the contract
     * @dev Reverts if contracts is not paused
     * @dev Reverts if sender has no `RESUME_ROLE`
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pause the contract for a specified period
     * @param _duration pause duration in seconds (use `PAUSE_INFINITELY` for unlimited)
     * @dev Reverts if contract is already paused
     * @dev Reverts if sender has no `PAUSE_ROLE`
     * @dev Reverts if zero duration is passed
     */
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /**
     * @notice Pause the contract until a specified timestamp
     * @param _pauseUntilInclusive the last second to pause until inclusive
     * @dev Reverts if the timestamp is in the past
     * @dev Reverts if sender has no `PAUSE_ROLE`
     * @dev Reverts if contract is already paused
     */
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /**
     * @notice Method verifying Merkle proofs on validators and proceeding to top up validators
     * via StakingRouter.topUp(stakingModuleId, keyIndices, operatorIds, pubkeys, topUpLimits)
     * @param _topUps TopUpData structure, containing validators' container fields, pending deposits
     *  and Merkle proofs on inclusion of each container in Beacon State tree
     * @dev Only callable by accounts with TOP_UP_ROLE.
     *
     * validatorIndices MUST be sorted in strictly ascending order. The corresponding keyIndices,
     * operatorIds, validatorWitness and pendingBalanceGwei arrays must be aligned by position
     * to validatorIndices[i].
     *
     * Reverts if:
     *  - the caller doesn't have TOP_UP_ROLE (AccessControl);
     *  - validatorIndices is empty, or any of keyIndices, operatorIds, validatorWitness,
     *    pendingBalanceGwei has a length different from validatorIndices
     *    (`WrongArrayLength`);
     *  - validatorIndices length exceeds maxValidatorsPerTopUp (`MaxValidatorsPerTopUpExceeded`);
     *  - validatorIndices is not strictly increasing (not sorted or contains duplicates) (`InvalidValidatorIndicesSortOrder`);
     *  - fewer than minBlockDistance blocks have passed since the last top-up (`MinBlockDistanceNotMet`);
     *  - the beacon root is older than maxRootAge relative to block.timestamp (`RootIsTooOld`);
     *  - the beacon root childBlockTimestamp is not newer than the last top-up timestamp
     *    (`RootPrecedesLastTopUp`);
     *  - the module's withdrawal credentials are not of type 0x02 (`WrongWithdrawalCredentials`);
     *  - any validator pubkey has a length different from 48 bytes (`WrongPubkeyLength`);
     *  - any validator has activationEpoch >= current epoch (derived from beacon root slot) (`ValidatorIsNotActivated`);
     *  - any validator Merkle proof fails verification in CLValidatorVerifier.
     */
    function topUp(TopUpData calldata _topUps) external onlyRole(TOP_UP_ROLE) whenResumed {
        Storage storage $ = _gatewayStorage();

        uint256 validatorsCount = _topUps.validatorIndices.length;
        if (validatorsCount == 0) revert WrongArrayLength();

        if (
            _topUps.keyIndices.length != validatorsCount || _topUps.operatorIds.length != validatorsCount
                || _topUps.validatorWitness.length != validatorsCount
                || _topUps.pendingBalanceGwei.length != validatorsCount
        ) {
            revert WrongArrayLength();
        }

        if (validatorsCount > $.maxValidatorsPerTopUp) {
            revert MaxValidatorsPerTopUpExceeded();
        }

        // Distance is for flexibility in future to control top-up frequency
        _requireBlockDistancePassed();

        // Check proof age
        // 0. _topUps.beaconRootData.childBlockTimestamp is newer than timestamp of last top up
        // 1. _topUps.beaconRootData.childBlockTimestamp is not older than maxRootAge
        _verifyRootAge(_topUps.beaconRootData);

        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());

        // Find and validate withdrawalCredentials 0x02
        bytes32 withdrawalCredentials = stakingRouter.getStakingModuleWithdrawalCredentials(_topUps.moduleId);
        _requireWithdrawalCredentials02(withdrawalCredentials);

        bytes[] memory pubkeys = new bytes[](validatorsCount);

        uint256[] memory topUpLimits = new uint256[](validatorsCount);

        uint256 totalLimits;

        // Track previous validator index to enforce strictly increasing order inline (see check below).
        uint256 prevValidatorIndex;

        // 1. Evaluate top-up limit based on current balance, pending deposits, and configured limits
        // 2. Verify proof data through CLValidatorProofVerifier
        unchecked {
            for (uint256 i; i < validatorsCount; ++i) {
                // For each validator
                ValidatorWitness calldata vw = _topUps.validatorWitness[i];

                if (vw.pubkey.length != PUBKEY_LENGTH) {
                    revert WrongPubkeyLength();
                }

                // Require validatorIndices to be strictly increasing (rejects duplicates and unsorted input).
                uint256 validatorIndex = _topUps.validatorIndices[i];
                if (i != 0 && validatorIndex <= prevValidatorIndex) {
                    revert InvalidValidatorIndicesSortOrder();
                }
                prevValidatorIndex = validatorIndex;

                _verifyValidatorWasActivated(_topUps.beaconRootData.slot, vw);

                _verifyValidator(_topUps.beaconRootData, vw, validatorIndex, withdrawalCredentials);

                pubkeys[i] = vw.pubkey;

                // calculate top up limit accounting for current balance and pending deposits
                topUpLimits[i] = _evaluateTopUpLimit(vw, _topUps.pendingBalanceGwei[i]) * 1 gwei;
                totalLimits += topUpLimits[i];
            }
        }

        // Proceed to StakingRouter
        stakingRouter.topUp(_topUps.moduleId, _topUps.keyIndices, _topUps.operatorIds, pubkeys, topUpLimits);

        if (totalLimits > 0) {
            _setLastTopUpData();
        }
    }

    /**
     * @notice Returns the timestamp when last top up happened
     */
    function getLastTopUpTimestamp() external view returns (uint256) {
        return _gatewayStorage().lastTopUpTimestamp;
    }

    /**
     * @notice Returns the allowed amount of validators per top up
     */
    function getMaxValidatorsPerTopUp() external view returns (uint256) {
        return _gatewayStorage().maxValidatorsPerTopUp;
    }

    /**
     * @notice Returns the min block distance that should pass from last top up
     */
    function getMinBlockDistance() external view returns (uint256) {
        return _gatewayStorage().minBlockDistance;
    }

    /**
     * @notice Returns true if enough blocks have passed since the last top-up
     *         (or no top-up has happened yet).
     */
    function isBlockDistancePassed() external view returns (bool) {
        return _isBlockDistancePassed();
    }

    /**
     * @notice Returns the maximum age (seconds) of beacon root relative to block.timestamp
     */
    function getMaxRootAge() external view returns (uint256) {
        return _gatewayStorage().maxRootAge;
    }

    /**
     * @notice Returns target validator balance ceiling after top-up (in Gwei)
     */
    function getTargetBalanceGwei() external view returns (uint256) {
        return _gatewayStorage().targetBalanceGwei;
    }

    /**
     * @notice Returns minimum top-up that can be performed (in Gwei).
     */
    function getMinTopUpGwei() external view returns (uint256) {
        return _gatewayStorage().minTopUpGwei;
    }

    /**
     * @notice Set max validators per top up value
     * @param _newValue Max validators per top up value
     */
    function setMaxValidatorsPerTopUp(uint256 _newValue) external onlyRole(MANAGE_LIMITS_ROLE) {
        _setMaxValidatorsPerTopUp(_newValue);
    }

    /**
     * @notice Set min block distance
     * @param _newValue Min block distance
     */
    function setMinBlockDistance(uint256 _newValue) external onlyRole(MANAGE_LIMITS_ROLE) {
        _setMinBlockDistance(_newValue);
    }

    /**
     * @notice Set targetBalanceGwei and minTopUpGwei values
     * @param _targetBalanceGwei target validator balance ceiling after top-up (in Gwei)
     * @param _minTopUpGwei  minimum top-up that can be performed (in Gwei).
     */
    function setTopUpBalanceLimits(uint256 _targetBalanceGwei, uint256 _minTopUpGwei)
        external
        onlyRole(MANAGE_LIMITS_ROLE)
    {
        _setTopUpBalanceLimits(_targetBalanceGwei, _minTopUpGwei);
    }

    /// @notice Sets the maximum allowed age of beacon root relative to current block timestamp
    /// @param _newValue Maximum age in seconds
    function setMaxRootAge(uint256 _newValue) external onlyRole(MANAGE_LIMITS_ROLE) {
        _setMaxRootAge(_newValue);
    }

    function _isBlockDistancePassed() internal view returns (bool) {
        Storage storage $ = _gatewayStorage();
        return $.lastTopUpBlock == 0 || block.number - $.lastTopUpBlock >= $.minBlockDistance;
    }

    function _requireBlockDistancePassed() internal view {
        if (!_isBlockDistancePassed()) {
            revert MinBlockDistanceNotMet();
        }
    }

    function _requireWithdrawalCredentials02(bytes32 _wc) internal pure {
        if (!_wc.isType2()) {
            revert WrongWithdrawalCredentials();
        }
    }

    function _setLastTopUpData() internal {
        Storage storage $ = _gatewayStorage();
        $.lastTopUpTimestamp = uint32(block.timestamp);
        $.lastTopUpBlock = uint32(block.number);
        emit LastTopUpChanged(block.timestamp);
    }

    function _setMaxRootAge(uint256 _newValue) internal {
        if (_newValue == 0) revert ZeroValue();
        if (_newValue > type(uint16).max) revert TooLargeValue();
        _gatewayStorage().maxRootAge = uint16(_newValue);

        emit MaxRootAgeChanged(_newValue);
    }

    function _setMaxValidatorsPerTopUp(uint256 _newValue) internal {
        if (_newValue == 0) revert ZeroValue();
        if (_newValue > type(uint64).max) revert TooLargeValue();
        _gatewayStorage().maxValidatorsPerTopUp = uint64(_newValue);
        emit MaxValidatorsPerTopUpChanged(_newValue);
    }

    function _setMinBlockDistance(uint256 _newValue) internal {
        if (_newValue == 0) revert ZeroValue();
        if (_newValue > type(uint16).max) revert TooLargeValue();
        _gatewayStorage().minBlockDistance = uint16(_newValue);
        emit MinBlockDistanceChanged(_newValue);
    }

    function _setTopUpBalanceLimits(uint256 _targetBalanceGwei, uint256 _minTopUpGwei) internal {
        if (_targetBalanceGwei == 0 || _minTopUpGwei == 0) revert ZeroValue();
        if (_targetBalanceGwei > type(uint64).max || _minTopUpGwei > type(uint64).max) revert TooLargeValue();
        if (_minTopUpGwei > _targetBalanceGwei) revert MinTopUpExceedsTarget();

        Storage storage $ = _gatewayStorage();
        $.targetBalanceGwei = uint64(_targetBalanceGwei);
        $.minTopUpGwei = uint64(_minTopUpGwei);
        emit TopUpBalanceLimitsChanged(_targetBalanceGwei, _minTopUpGwei);
    }

    function _verifyRootAge(BeaconRootData calldata _beaconRootData) internal view {
        if (block.timestamp > _beaconRootData.childBlockTimestamp + _gatewayStorage().maxRootAge) {
            revert RootIsTooOld();
        }

        if (_beaconRootData.childBlockTimestamp <= _gatewayStorage().lastTopUpTimestamp) {
            revert RootPrecedesLastTopUp();
        }
    }

    function _verifyValidatorWasActivated(uint64 _slot, ValidatorWitness calldata _w) internal view {
        // header slot epoch
        uint64 epoch = uint64(_slot / SLOTS_PER_EPOCH);
        if (_w.activationEpoch > epoch) revert ValidatorIsNotActivated();
    }

    function _evaluateTopUpLimit(ValidatorWitness calldata _validator, uint256 _pendingBalanceGwei)
        internal
        view
        returns (uint256)
    {
        // withdrawableEpoch is intentionally not checked: per the consensus spec it is only ever set
        // together with exitEpoch, so `exitEpoch != FAR_FUTURE_EPOCH` already covers the exiting/exited case.
        if (_validator.exitEpoch != FAR_FUTURE_EPOCH || _validator.slashed) {
            return 0;
        }

        Storage storage $ = _gatewayStorage();
        uint256 currentTotal = _validator.effectiveBalance + _pendingBalanceGwei;
        if (currentTotal >= $.targetBalanceGwei) return 0;

        uint256 topUpLimit = $.targetBalanceGwei - currentTotal;
        if (topUpLimit < $.minTopUpGwei) return 0;

        return topUpLimit;
    }

    function _gatewayStorage() internal pure returns (Storage storage $) {
        bytes32 position = GATEWAY_STORAGE_POSITION;
        assembly ("memory-safe") {
            $.slot := position
        }
    }

    event MaxValidatorsPerTopUpChanged(uint256 newValue);
    event MinBlockDistanceChanged(uint256 newValue);
    event LastTopUpChanged(uint256 newValue);
    event MaxRootAgeChanged(uint256 newValue);
    event TopUpBalanceLimitsChanged(uint256 targetBalanceGwei, uint256 minTopUpGwei);

    error ZeroValue();
    error ZeroArgument(string argument);
    error TooLargeValue();
    error RootIsTooOld();
    error RootPrecedesLastTopUp();
    error WrongArrayLength();
    error MaxValidatorsPerTopUpExceeded();
    error WrongWithdrawalCredentials();
    error WrongPubkeyLength();
    error MinBlockDistanceNotMet();
    error InvalidValidatorIndicesSortOrder();
    error ValidatorIsNotActivated();
    error MinTopUpExceedsTarget();
}
