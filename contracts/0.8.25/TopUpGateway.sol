// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {TopUpData, BeaconRootData, ValidatorWitness} from "contracts/common/interfaces/TopUpWitness.sol";
import {CLTopUpVerifier} from "./CLTopUpVerifier.sol";
import {
    AccessControlEnumerableUpgradeable
} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {WithdrawalCredentials} from "contracts/common/lib/WithdrawalCredentials.sol";

interface ILidoLocator {
    function stakingRouter() external view returns (address);
    function lido() external view returns (address);
}

interface IStakingRouter {
    function getStakingModuleWithdrawalCredentials(uint256 _stakingModuleId) external view returns (bytes32);
    function canDeposit(uint256 _stakingModuleId) external view returns (bool);
    function topUp(
        uint256 _stakingModuleId,
        uint256[] calldata _keyIndices,
        uint256[] calldata _operatorIds,
        bytes[] calldata _pubkeys,
        uint256[] calldata _topUpLimits
    ) external;
}

interface ILido {
    function canDeposit() external view returns (bool);
}

/**
 * @title TopUpGateway
 * @author Lido
 * @notice TopUpGateway is a contract that serves as the entry point for validator top-ups
 */
contract TopUpGateway is CLTopUpVerifier, AccessControlEnumerableUpgradeable {
    using WithdrawalCredentials for bytes32;

    ILidoLocator internal immutable LOCATOR;

    struct Storage {
        uint64 maxValidatorsPerTopUp; // 64
        uint32 lastTopUpSlot; // 32
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

    bytes32 public constant TOP_UP_ROLE = keccak256("TOP_UP_GATEWAY_TOP_UP_ROLE");
    bytes32 public constant MANAGE_LIMITS_ROLE = keccak256("TOP_UP_GATEWAY_MANAGE_LIMITS_ROLE");

    constructor(
        address _lidoLocator,
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        uint64 _pivotSlot,
        uint256 _slotsPerEpoch
    ) CLTopUpVerifier(_gIFirstValidatorPrev, _gIFirstValidatorCurr, _pivotSlot) {
        LOCATOR = ILidoLocator(_lidoLocator);
        SLOTS_PER_EPOCH = _slotsPerEpoch;
        _disableInitializers();
    }

    /// @notice Initializes the TopUpGateway proxy with admin, rate limits, and top-up balance parameters.
    /// @param _admin Address to receive DEFAULT_ADMIN_ROLE
    /// @param _maxValidatorsPerTopUp Maximum number of validators per single topUp call
    /// @param _minBlockDistance Minimum blocks between topUp calls
    /// @param _maxRootAgeSec Maximum age (seconds) of beacon root relative to block.timestamp
    /// @param _targetBalanceGwei Target validator balance ceiling after top-up (in Gwei).
    ///        Top-up amount = targetBalance - currentTotal.
    /// @param _minTopUpGwei Minimum top-up that can be performed (in Gwei). If calculated top-up < minTopUp, returns 0.
    ///        Must be <= _targetBalanceGwei.
    ///
    /// @dev Ethereum reference values (0x02 validators, MAX_EFFECTIVE_BALANCE = 2048 ETH):
    ///        _targetBalanceGwei = 2046.75 ETH (2048e9 - 1.25e9 Gwei) — leaves 1.25 ETH safety margin
    ///        _minTopUpGwei      = 1 ETH (1e9 Gwei) — skip top-ups below 1 ETH
    function initialize(
        address _admin,
        uint256 _maxValidatorsPerTopUp,
        uint256 _minBlockDistance,
        uint256 _maxRootAgeSec,
        uint256 _targetBalanceGwei,
        uint256 _minTopUpGwei
    ) external initializer {
        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _setMaxValidatorsPerTopUp(_maxValidatorsPerTopUp);
        _setMinBlockDistance(_minBlockDistance);
        _setMaxRootAge(_maxRootAgeSec);
        _setTopUpBalanceLimits(_targetBalanceGwei, _minTopUpGwei);
    }

    /**
     * @notice Method verifying Merkle proofs on validators, making check of age of slot's proof
     * and proceeding to top up validators via StakingRouter.topUp(stakingModuleId, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei)
     * @param _topUps TopUpData structure, containing validators' container fields, actual balances and pending deposits
     *  and Merkle proofs on inclusion of each container in Beacon State tree
     * @dev Amount of validators limited by maxValidatorsPerTopUp; Between topUp calls should pass minBlockDistance.
     *      Only callable by accounts with TOP_UP_ROLE.
     */
    function topUp(TopUpData calldata _topUps) external onlyRole(TOP_UP_ROLE) {
        Storage storage $ = _gatewayStorage();

        uint256 validatorsCount = _topUps.validatorIndices.length;
        if (validatorsCount == 0) revert WrongArrayLength();

        if (
            _topUps.keyIndices.length != validatorsCount || _topUps.operatorIds.length != validatorsCount
                || _topUps.validatorWitness.length != validatorsCount || _topUps.pendingBalanceGwei.length != validatorsCount
        ) {
            revert WrongArrayLength();
        }

        // length should be less than or eq maxValidatorsPerTopUp
        if (validatorsCount > $.maxValidatorsPerTopUp) {
            revert MaxValidatorsPerTopUpExceeded();
        }

        // Check for duplicate validatorIndices (O(n^2) acceptable since bounded by maxValidatorsPerTopUp)
        for (uint256 i; i < validatorsCount; ++i) {
            for (uint256 j = i + 1; j < validatorsCount; ++j) {
                if (_topUps.validatorIndices[i] == _topUps.validatorIndices[j]) {
                    revert DuplicateValidatorIndex();
                }
            }
        }

        _requireBlockDistancePassed();

        // Data checks
        // 0. slot should not be older than X from current slot, or timestamp
        // also should be newer than previous slot on X
        _verifyRootAge(_topUps.beaconRootData);

        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());

        // Find and validate withdrawalCredentials 0x02
        bytes32 withdrawalCredentials = stakingRouter.getStakingModuleWithdrawalCredentials(_topUps.moduleId);
        _requireWithdrawalCredentials02(withdrawalCredentials);

        bytes[] memory pubkeys = new bytes[](validatorsCount);

        uint256[] memory topUpLimits = new uint256[](validatorsCount);

        // 1. Evaluate top-up limit based on current balance, pending deposits, and configured limits
        // 2. Verify proof data through CLValidatorProofVerifier
        unchecked {
            for (uint256 i; i < validatorsCount; ++i) {
                // For each validator
                ValidatorWitness calldata vw = _topUps.validatorWitness[i];

                if (vw.pubkey.length != PUBKEY_LENGTH) {
                    revert WrongPubkeyLength();
                }

                _verifyValidatorWasActivated(_topUps.beaconRootData.slot, vw);

                _verifyValidator(_topUps.beaconRootData, vw, _topUps.validatorIndices[i], withdrawalCredentials);

                pubkeys[i] = vw.pubkey;

                // calculate top up limit accounting for current balance and pending deposits
                topUpLimits[i] = _evaluateTopUpLimit(vw, _topUps.pendingBalanceGwei[i]) * 1 gwei;
            }
        }

        // Proceed to StakingRouter
        IStakingRouter(stakingRouter).topUp(
            _topUps.moduleId, _topUps.keyIndices, _topUps.operatorIds, pubkeys, topUpLimits
        );

        _setLastTopUpSlot(_topUps.beaconRootData.slot);
    }

    /**
     * @notice Checks if top-up is possible for a given staking module
     * @param _stakingModuleId Id of the staking module
     * @return True if top-up is possible, false otherwise
     * @dev Checks: module exists, module is active, block distance passed, Lido can deposit, and withdrawal credentials are 0x02
     */
    function canTopUp(uint256 _stakingModuleId) external view returns (bool) {
        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());

        if (!stakingRouter.canDeposit(_stakingModuleId)) return false;
        if (!ILido(LOCATOR.lido()).canDeposit()) return false;
        if (!_isBlockDistancePassed()) return false;

        bytes32 wc = stakingRouter.getStakingModuleWithdrawalCredentials(_stakingModuleId);
        return wc.isType2();
    }

    /**
     * @notice Returns the slot number of the last top up
     * @return lastTopUpSlot The slot number of the last top up.
     */
    function getLastTopUpSlot() external view returns (uint256) {
        return _gatewayStorage().lastTopUpSlot;
    }

    function getMaxValidatorsPerTopUp() external view returns (uint256) {
        return _gatewayStorage().maxValidatorsPerTopUp;
    }

    function getMinBlockDistance() external view returns (uint256) {
        return _gatewayStorage().minBlockDistance;
    }

    function getMaxRootAge() external view returns (uint256) {
        return _gatewayStorage().maxRootAge;
    }

    function setMaxValidatorsPerTopUp(uint256 _newValue) external onlyRole(MANAGE_LIMITS_ROLE) {
        _setMaxValidatorsPerTopUp(_newValue);
    }

    function setMinBlockDistance(uint256 _newValue) external onlyRole(MANAGE_LIMITS_ROLE) {
        _setMinBlockDistance(_newValue);
    }

    function getTargetBalanceGwei() external view returns (uint256) {
        return _gatewayStorage().targetBalanceGwei;
    }

    function getMinTopUpGwei() external view returns (uint256) {
        return _gatewayStorage().minTopUpGwei;
    }

    function setTopUpBalanceLimits(uint256 _targetBalanceGwei, uint256 _minTopUpGwei) external onlyRole(MANAGE_LIMITS_ROLE) {
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

    function _setLastTopUpSlot(uint256 _newValue) internal {
        Storage storage $ = _gatewayStorage();
        $.lastTopUpSlot = uint32(_newValue);
        $.lastTopUpBlock = uint32(block.number);
        emit LastTopUpChanged(_newValue);
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

        if (_beaconRootData.slot <= _gatewayStorage().lastTopUpSlot) revert SlotNotIncreasing();
    }

    function _verifyValidatorWasActivated(uint64 _slot, ValidatorWitness calldata _w) internal view {
        // header slot epoch
        uint64 epoch = uint64(_slot / SLOTS_PER_EPOCH);
        // Validator should be activated earlier than current epoch
        if (_w.activationEpoch >= epoch) revert ValidatorIsNotActivated();
    }

    function _evaluateTopUpLimit(ValidatorWitness calldata _validator, uint256 _pendingBalanceGwei)
        internal
        view
        returns (uint256)
    {
        if (
            _validator.exitEpoch != FAR_FUTURE_EPOCH || _validator.slashed
                || _validator.withdrawableEpoch != FAR_FUTURE_EPOCH
        ) {
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
    error TooLargeValue();
    error RootIsTooOld();
    error SlotNotIncreasing();
    error WrongArrayLength();
    error MaxValidatorsPerTopUpExceeded();
    error WrongWithdrawalCredentials();
    error WrongPubkeyLength();
    error MinBlockDistanceNotMet();
    error DuplicateValidatorIndex();
    error ValidatorIsNotActivated();
    error MinTopUpExceedsTarget();
}
