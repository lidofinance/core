// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {
    BeaconRootData,
    ValidatorWitness,
    BalanceWitness,
    PendingWitness
} from "contracts/common/interfaces/TopUpWitness.sol";
import {CLTopUpVerifier} from "./CLTopUpVerifier.sol";
import {AccessControlEnumerableUpgradeable} from
    "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {WithdrawalCredentials} from "contracts/common/lib/WithdrawalCredentials.sol";

interface ILidoLocator {
    function stakingRouter() external view returns (address);
    function lido() external view returns (address);
}

interface IStakingRouter {
    function getStakingModuleWithdrawalCredentials(uint256 _stakingModuleId) external view returns (bytes32);
    function hasStakingModule(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleIsActive(uint256 _stakingModuleId) external view returns (bool);
}

interface ILido {
    function topUp(
        uint256 _stakingModuleId,
        uint256[] calldata _keyIndices,
        uint256[] calldata _operatorIds,
        bytes calldata _pubkeysPacked,
        uint256[] calldata _topUpLimitsGwei
    ) external;
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
        uint8 minBlockDistance; // 8
    }

    /// @dev Storage slot: keccak256(abi.encode(uint256(keccak256("lido.TopUpGateway.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant GATEWAY_STORAGE_POSITION =
        0x22e512057841e2bc1e6d80030c8bb8b4935377af2e64ba9bf8e6a3e88fb32200;

    uint256 internal constant BALANCE_THRESHOLD_GWEI = 2047 ether / 1 gwei;
    uint256 internal constant MAX_EFFECTIVE_BALANCE_02_GWEI = 2048 ether / 1 gwei;
    uint256 internal constant PUBKEY_LENGTH = 48;
    uint256 internal constant MAX_ROOT_AGE = 5 minutes;
    uint256 internal constant FAR_FUTURE_EPOCH = type(uint64).max;

    bytes32 public constant TOP_UP_ROLE = keccak256("TOP_UP_GATEWAY_TOP_UP_ROLE");
    bytes32 public constant MANAGE_LIMITS_ROLE = keccak256("TOP_UP_GATEWAY_MANAGE_LIMITS_ROLE");

    struct TopUpData {
        uint256 moduleId;
        // list of validators pubkeys
        // bytes[] pubkeys;
        // key indexes and operator ids needed to verify key belong to module
        uint256[] keyIndices;
        uint256[] operatorIds;
        uint256[] validatorIndices;
        BeaconRootData beaconRootData;
        ValidatorWitness[] validatorWitness;
        BalanceWitness[] balanceWitness;
        PendingWitness[][] pendingWitness;
    }

    constructor(
        address _admin,
        address _lidoLocator,
        uint256 _maxValidatorsPerTopUp,
        uint256 _minBlockDistance,
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        GIndex _gIFirstBalancePrev,
        GIndex _gIFirstBalanceCurr,
        GIndex _gIFirstPendingPrev,
        GIndex _gIFirstPendingCurr,
        uint64 _pivotSlot
    )
        CLTopUpVerifier(
            _gIFirstValidatorPrev,
            _gIFirstValidatorCurr,
            _gIFirstBalancePrev,
            _gIFirstBalanceCurr,
            _gIFirstPendingPrev,
            _gIFirstPendingCurr,
            _pivotSlot
        )
        initializer
    {
        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        LOCATOR = ILidoLocator(_lidoLocator);
        _setMaxValidatorsPerTopUp(_maxValidatorsPerTopUp);
        _setMinBlockDistance(_minBlockDistance);
    }

    /**
     * @notice Method verifying Merkle proofs on validators, actual balances and pending deposits on validators, making check of age of slot's proof
     * and proceeding to top up validators via Lido.topUp(stakingModuleId, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei)
     * @param topUps TopUpData structure, containing validators' container fields, actual balances and pending deposits
     *  and Merkle proofs on inclusion of each container in Beacon State tree
     * @dev Amount of validators limited by maxValidatorsPerTopUp; Between topUp calls should pass minBlockDistance.
     *      Only callable by accounts with TOP_UP_ROLE.
     */
    function topUp(TopUpData calldata topUps) external onlyRole(TOP_UP_ROLE) {
        Storage storage $ = _gatewayStorage();

        uint256 validatorsCount = topUps.validatorIndices.length;
        if (validatorsCount == 0) revert WrongArrayLength();

        if (
            topUps.keyIndices.length != validatorsCount || topUps.operatorIds.length != validatorsCount
                || topUps.validatorWitness.length != validatorsCount || topUps.balanceWitness.length != validatorsCount
                || topUps.pendingWitness.length != validatorsCount
        ) {
            revert WrongArrayLength();
        }

        // Check for duplicate validatorIndices (O(n^2) acceptable since bounded by maxValidatorsPerTopUp)
        for (uint256 i; i < validatorsCount; ++i) {
            for (uint256 j = i + 1; j < validatorsCount; ++j) {
                if (topUps.validatorIndices[i] == topUps.validatorIndices[j]) {
                    revert DuplicateValidatorIndex();
                }
            }
        }

        // length should be less than or eq maxValidatorsPerTopUp
        if (validatorsCount > $.maxValidatorsPerTopUp) {
            revert MaxValidatorsPerTopUpExceeded();
        }

        if ($.lastTopUpBlock != 0 && block.number - $.lastTopUpBlock < $.minBlockDistance) {
            revert MinBlockDistanceNotMet();
        }

        // Data checks
        // 0. slot should not be older than X from current slot, or timestamp
        // also should be newer than previous slot on X
        _verifyRootAge(topUps.beaconRootData);

        // Find withdrawalCredentials 0x02
        bytes32 withdrawalCredentials =
            IStakingRouter(LOCATOR.stakingRouter()).getStakingModuleWithdrawalCredentials(topUps.moduleId);

        // check 0x02 type
        if (withdrawalCredentials.getType() != 2) {
            revert WrongWithdrawalCredentials();
        }

        bytes memory pubkeysPacked = new bytes(validatorsCount * PUBKEY_LENGTH);

        uint256[] memory topUpLimits = new uint256[](validatorsCount);

        // 1. actual balance should not be bigger than 2047 ether
        // 2. Verify proof data through CLValidatorProofVerifier
        unchecked {
            for (uint256 i; i < validatorsCount; ++i) {
                BalanceWitness calldata bw = topUps.balanceWitness[i];

                // For each validator
                ValidatorWitness calldata vw = topUps.validatorWitness[i];
                bytes calldata pubkey = vw.pubkey;

                if (vw.pubkey.length != PUBKEY_LENGTH) {
                    revert InvalidTopUpPubkeyLength();
                }

                _verifyValidatorWCActiveAndBalance(
                    topUps.beaconRootData,
                    vw,
                    topUps.balanceWitness[i],
                    topUps.pendingWitness[i],
                    topUps.validatorIndices[i],
                    withdrawalCredentials
                );

                assembly {
                    let dest := add(add(pubkeysPacked, 0x20), mul(i, PUBKEY_LENGTH))
                    calldatacopy(dest, pubkey.offset, PUBKEY_LENGTH)
                }

                // calculate top up limit accounting for current balance and pending deposits
                topUpLimits[i] = _evaluateToUpLimit(vw, bw, topUps.pendingWitness[i]);
            }
        }

        // Proceed to Lido
        ILido(LOCATOR.lido()).topUp(topUps.moduleId, topUps.keyIndices, topUps.operatorIds, pubkeysPacked, topUpLimits);

        _setLastTopUpSlot(topUps.beaconRootData.slot);
    }

    /**
     * @notice Returns the slot number of the last top up
     * @return lastTopUpSlot The slot number of the last top up.
     */
    function getLastTopUpSlot() external view returns (uint256) {
        return _gatewayStorage().lastTopUpSlot;
    }

    function maxValidatorsPerTopUp() public view returns (uint256) {
        return _gatewayStorage().maxValidatorsPerTopUp;
    }

    function minBlockDistance() public view returns (uint256) {
        return _gatewayStorage().minBlockDistance;
    }

    /**
     * @notice Checks if top-up is possible for a given staking module
     * @param _stakingModuleId Id of the staking module
     * @return True if top-up is possible, false otherwise
     * @dev Checks: module exists, module is active, block distance passed, Lido can deposit, and withdrawal credentials are 0x02
     */
    function canTopUp(uint256 _stakingModuleId) external view returns (bool) {
        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());

        if (!stakingRouter.hasStakingModule(_stakingModuleId)) return false;

        bool isModuleActive = stakingRouter.getStakingModuleIsActive(_stakingModuleId);

        Storage storage $ = _gatewayStorage();
        bool isBlockDistancePassed = $.lastTopUpBlock == 0 || block.number - $.lastTopUpBlock >= $.minBlockDistance;

        bool isLidoCanDeposit = ILido(LOCATOR.lido()).canDeposit();

        // Check 0x02 type
        bytes32 wc = stakingRouter.getStakingModuleWithdrawalCredentials(_stakingModuleId);
        bool isWC02 = wc.getType() == 2;

        return isModuleActive && isBlockDistancePassed && isLidoCanDeposit && isWC02;
    }

    function setMaxValidatorsPerTopUp(uint256 newValue) external onlyRole(MANAGE_LIMITS_ROLE) {
        _setMaxValidatorsPerTopUp(newValue);
    }

    function setMinBlockDistance(uint256 newValue) external onlyRole(MANAGE_LIMITS_ROLE) {
        _setMinBlockDistance(newValue);
    }

    function _setLastTopUpSlot(uint256 newValue) internal {
        Storage storage $ = _gatewayStorage();
        $.lastTopUpSlot = uint32(newValue);
        $.lastTopUpBlock = uint32(block.number);
        emit LastTopUpChanged(newValue);
    }

    function _verifyRootAge(BeaconRootData calldata beaconRootData) internal view {
        if (block.timestamp > beaconRootData.childBlockTimestamp + MAX_ROOT_AGE) {
            revert RootIsTooOld();
        }

        if (beaconRootData.slot <= _gatewayStorage().lastTopUpSlot) revert SlotNotIncreasing();
    }

    function _evaluateToUpLimit(
        ValidatorWitness calldata validator,
        BalanceWitness calldata balance,
        PendingWitness[] calldata pendingDeposits
    ) internal pure returns (uint64) {
        if (
            validator.exitEpoch != FAR_FUTURE_EPOCH || validator.slashed
                || validator.withdrawableEpoch != FAR_FUTURE_EPOCH
        ) {
            return 0;
        }

        // Sum all pending deposits for this validator
        uint256 totalPendingGwei = 0;
        for (uint256 i = 0; i < pendingDeposits.length; ++i) {
            totalPendingGwei += pendingDeposits[i].amount;
        }

        // Top-up limit = MAX_EFFECTIVE_BALANCE - current_balance - pending_deposits
        uint256 currentTotal = balance.balanceGwei + totalPendingGwei;
        if (currentTotal > BALANCE_THRESHOLD_GWEI) {
            return 0;
        }

        return uint64(MAX_EFFECTIVE_BALANCE_02_GWEI - currentTotal);
    }

    function _setMaxValidatorsPerTopUp(uint256 newValue) internal {
        if (newValue == 0) revert ZeroValue();
        _gatewayStorage().maxValidatorsPerTopUp = uint64(newValue);
        emit MaxValidatorsPerReportChanged(newValue);
    }

    function _setMinBlockDistance(uint256 newValue) internal {
        if (newValue == 0) revert ZeroValue();
        _gatewayStorage().minBlockDistance = uint8(newValue);
        emit MinBlockDistanceChanged(newValue);
    }

    function _gatewayStorage() internal pure returns (Storage storage $) {
        bytes32 position = GATEWAY_STORAGE_POSITION;
        assembly ("memory-safe") {
            $.slot := position
        }
    }

    event MaxValidatorsPerReportChanged(uint256 newValue);
    event MinBlockDistanceChanged(uint256 newValue);
    event LastTopUpChanged(uint256 newValue);

    error ZeroValue();
    error RootIsTooOld();
    error SlotNotIncreasing();
    error WrongArrayLength();
    error MaxValidatorsPerTopUpExceeded();
    error WrongWithdrawalCredentials();
    error InvalidTopUpPubkeyLength();
    error MinBlockDistanceNotMet();
    error DuplicateValidatorIndex();
}
