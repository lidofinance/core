// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {SRStorage} from "./SRStorage.sol";
import {ModuleState} from "./SRTypes.sol";
import {WithdrawalCredentials} from "contracts/common/lib/WithdrawalCredentials.sol";

library SRUtils {
    using SRStorage for ModuleState;
    using SRStorage for uint256; // for module IDs

    uint256 public constant TOTAL_BASIS_POINTS = 10000;
    uint256 public constant MAX_STAKING_MODULES_COUNT = 32;
    /// @dev Restrict the name size with 31 bytes to storage in a single slot.
    uint256 public constant MAX_STAKING_MODULE_NAME_LENGTH = 31;

    // Max Effective Balance for Withdrawal Credentials types
    uint256 public constant MAX_EFFECTIVE_BALANCE_WC_TYPE_01 = 32 ether;
    uint256 public constant MAX_EFFECTIVE_BALANCE_WC_TYPE_02 = 2048 ether;

    /// @dev Large enough to fit all existing Ether per entity, yet overflow-safe when aggregating a reasonable number of entities
    uint256 internal constant MAX_VALUE_GWEI = 1_000_000_000 ether / 1 gwei; // i.e. 1B ETH

    /// @notice Initial deposit amount made for validator creation
    /// @dev Identical for both 0x01 and 0x02 types.
    ///      For 0x02, the validator may later be topped up.
    ///      Top-ups are not supported for 0x01.
    uint256 public constant INITIAL_DEPOSIT_SIZE = MAX_EFFECTIVE_BALANCE_WC_TYPE_01;

    error StakingModulesLimitExceeded();
    error StakingModuleWrongName();
    error StakingModuleUnregistered();
    error WrongWithdrawalCredentialsType();
    error InvalidPriorityExitShareThreshold();
    error InvalidMinDepositBlockDistance();
    error InvalidMaxDepositPerBlockValue();
    error InvalidAmountGwei();
    error InvalidStakeShareLimit();
    error InvalidFeeSum();
    error AppAuthFailed();
    error ZeroAddress();

    /// @dev mimic OpenZeppelin ContextUpgradeable._msgSender()
    function _msgSender() internal view returns (address) {
        return msg.sender;
    }

    function _validateAuth(address app) internal view {
        if (_msgSender() != app) revert AppAuthFailed();
    }

    function _validateZeroAddress(address target) internal pure {
        if (target == address(0)) revert ZeroAddress();
    }

    /// @dev Reverts if the string length is out of allowed limit
    function _validateModuleName(string memory name) internal pure {
        if (bytes(name).length == 0 || bytes(name).length > MAX_STAKING_MODULE_NAME_LENGTH) {
            revert StakingModuleWrongName();
        }
    }

    function _validateModuleShare(uint256 _stakeShareLimit, uint256 _priorityExitShareThreshold) internal pure {
        if (_stakeShareLimit > TOTAL_BASIS_POINTS) revert InvalidStakeShareLimit();
        if (_priorityExitShareThreshold > TOTAL_BASIS_POINTS) revert InvalidPriorityExitShareThreshold();
        if (_stakeShareLimit > _priorityExitShareThreshold) {
            revert InvalidPriorityExitShareThreshold();
        }
    }

    function _validateModuleFee(uint256 _moduleFee, uint256 _treasuryFee) internal pure {
        if (_moduleFee + _treasuryFee > TOTAL_BASIS_POINTS) revert InvalidFeeSum();
    }

    function _validateModuleDepositParams(uint256 _minDepositBlockDistance, uint256 _maxDepositsPerBlock)
        internal
        pure
    {
        if (_minDepositBlockDistance == 0 || _minDepositBlockDistance > type(uint64).max) {
            revert InvalidMinDepositBlockDistance();
        }
        if (_maxDepositsPerBlock > type(uint64).max) revert InvalidMaxDepositPerBlockValue();
    }

    function _validateAmountGwei(uint256 _amountGwei) internal pure returns (uint64) {
        if (_amountGwei > MAX_VALUE_GWEI) {
            revert InvalidAmountGwei();
        }
        return uint64(_amountGwei);
    }

    function _validateModulesCount() internal view {
        if (SRStorage.getModulesCount() >= MAX_STAKING_MODULES_COUNT) {
            revert StakingModulesLimitExceeded();
        }
    }

    function _validateModuleId(uint256 _moduleId) internal view {
        if (!SRStorage.isModuleId(_moduleId)) {
            revert StakingModuleUnregistered();
        }
    }

    function _getModuleMEB(uint256 _wcType) internal pure returns (uint256) {
        if (WithdrawalCredentials.isType1(_wcType)) {
            return MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
        } else if (WithdrawalCredentials.isType2(_wcType)) {
            return MAX_EFFECTIVE_BALANCE_WC_TYPE_02;
        } else {
            revert WrongWithdrawalCredentialsType();
        }
    }

    function _validateWC(uint256 _wcType) internal pure {
        if (!WithdrawalCredentials.isType1(_wcType) && !WithdrawalCredentials.isType2(_wcType)) {
            revert WrongWithdrawalCredentialsType();
        }
    }

    function _validateWC0x02(uint256 _wcType) internal pure {
        if (!WithdrawalCredentials.isType2(_wcType)) {
            revert WrongWithdrawalCredentialsType();
        }
    }

    function _toE4Precision(uint256 _value, uint256 _precision) internal pure returns (uint16) {
        return uint16((_value * TOTAL_BASIS_POINTS) / _precision);
    }

    function _getModuleIndexById(uint256 moduleId) internal view returns (uint256 idx) {
        idx = SRStorage.getModuleInternalPositionById(moduleId);
        if (idx == 0) {
            revert StakingModuleUnregistered();
        }
        unchecked {
            // Adjust for 1-based indexing
            --idx;
        }
    }

    ///  @dev get current balance of the module in ETH (wei)
    function _getModuleValidatorBalance(uint256 moduleId) internal view returns (uint256) {
        return _fromGwei(moduleId.getModuleState().accounting.validatorBalanceGwei);
    }

    function _getModuleBalance(uint256 moduleId) internal view returns (uint256) {
        return _getModuleValidatorBalance(moduleId) + _fromGwei(moduleId.getModuleState().accounting.pendingBalanceGwei);
    }

    ///  @dev get total balance of all modules (active + pending) in ETH
    function _getTotalModulesValidatorBalance() internal view returns (uint256) {
        return _fromGwei(SRStorage.getRouterState().accounting.validatorBalanceGwei);
    }

    function _getTotalModulesBalance() internal view returns (uint256) {
        return _getTotalModulesValidatorBalance() + _fromGwei(SRStorage.getRouterState().accounting.pendingBalanceGwei);
    }

    function _toGwei(uint256 amount) internal pure returns (uint64) {
        amount /= 1 gwei;
        return _validateAmountGwei(amount);
    }

    function _fromGwei(uint256 amount) internal pure returns (uint256) {
        return amount * 1 gwei;
    }

    function _getInitialDepositAmountByCount(uint256 depositsCount) internal pure returns (uint256) {
        return depositsCount * INITIAL_DEPOSIT_SIZE;
    }

    function _getInitialDepositCountByAmount(uint256 depositsAmount) internal pure returns (uint256) {
        return depositsAmount / INITIAL_DEPOSIT_SIZE;
    }
}
