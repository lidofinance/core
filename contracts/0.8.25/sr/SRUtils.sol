// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {SRStorage} from "./SRStorage.sol";
import {StakingModuleType, Strategies, Metrics, ModuleState} from "./SRTypes.sol";
import {DepositsTracker} from "contracts/common/lib/DepositsTracker.sol";
import {DepositedState} from "contracts/common/interfaces/DepositedState.sol";

library SRUtils {
    using SRStorage for ModuleState;
    using SRStorage for uint256; // for module IDs
    using DepositsTracker for DepositedState;

    uint256 public constant TOTAL_BASIS_POINTS = 10000;
    // uint256 internal constant TOTAL_METRICS_COUNT = 2;
    uint256 public constant MAX_STAKING_MODULES_COUNT = 32;
    /// @dev Restrict the name size with 31 bytes to storage in a single slot.
    uint256 public constant MAX_STAKING_MODULE_NAME_LENGTH = 31;

    // Max Effective Balance for Withdrawal Credentials types
    uint256 public constant MAX_EFFECTIVE_BALANCE_WC_TYPE_01 = 32 ether;
    uint256 public constant MAX_EFFECTIVE_BALANCE_WC_TYPE_02 = 2048 ether;
    // Withdrawal Credentials types
    uint8 public constant WC_TYPE_01 = 0x01;
    uint8 public constant WC_TYPE_02 = 0x02;

    error ZeroAddressStakingModule();
    error StakingModulesLimitExceeded();
    error StakingModuleAddressExists();
    error StakingModuleWrongName();
    error StakingModuleUnregistered();
    error InvalidStakingModuleType();
    error InvalidWithdrawalCredentialsType();
    error InvalidPriorityExitShareThreshold();
    error InvalidMinDepositBlockDistance();
    error InvalidMaxDepositPerBlockValue();
    error InvalidAmountGwei();
    error InvalidStakeShareLimit();
    error InvalidFeeSum();

    /// @notice Returns true if the string length is within the allowed limit
    function _validateModuleName(string memory name) internal pure {
        if (bytes(name).length == 0 || bytes(name).length > MAX_STAKING_MODULE_NAME_LENGTH) {
            revert StakingModuleWrongName();
        }
    }

    function _validateModuleAddress(address _moduleAddress) internal pure {
        if (_moduleAddress == address(0)) revert ZeroAddressStakingModule();
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

    function _validateAmountGwei(uint256 _amountGwei) internal pure {
        if (_amountGwei > type(uint96).max) {
            revert InvalidAmountGwei();
        }
    }

    function _validateModuleType(uint256 _moduleType) internal pure {
        /// @dev check module type
        if (_moduleType != uint8(StakingModuleType.Legacy) && _moduleType != uint8(StakingModuleType.New)) {
            revert InvalidStakingModuleType();
        }
    }

    function _validateWithdrawalCredentialsType(uint256 v) internal pure{
        // allow exactly 1 or 2 (0x01 / 0x02)
        if (v != WC_TYPE_01 && v != WC_TYPE_02) {
          revert InvalidWithdrawalCredentialsType();
        }
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

    function _getModuleMEB(uint8 wcType) internal pure returns (uint256) {
      if (wcType == WC_TYPE_01) return MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
      if (wcType == WC_TYPE_02) return MAX_EFFECTIVE_BALANCE_WC_TYPE_02;
      revert InvalidWithdrawalCredentialsType();
    }

    function _toE4Precision(uint256 _value, uint256 _precision) internal pure returns (uint16) {
        return uint16((_value * TOTAL_BASIS_POINTS) / _precision);
    }

    ///  @dev define metric IDs
    function _getMetricIds() internal pure returns (uint8[] memory metricIds) {
        metricIds = new uint8[](2);
        metricIds[0] = uint8(Metrics.DepositTargetShare);
        metricIds[1] = uint8(Metrics.WithdrawalProtectShare);
    }

    ///  @dev define strategy IDs
    function _getStrategyIds() internal pure returns (uint8[] memory strategyIds) {
        strategyIds = new uint8[](2);
        strategyIds[0] = uint8(Strategies.Deposit);
        strategyIds[1] = uint8(Strategies.Withdrawal);
        // strategyIds[2] = uint8(Strategies.Reward);
    }

    ///  @dev get current balance of the module in ETH
    function _getModuleBalance(uint256 moduleId) internal view returns (uint256) {
        uint256 clBalance = _fromGwei(moduleId.getModuleState().getStateAccounting().clBalanceGwei);
        uint256 pendingDeposits = SRStorage.getStakingModuleTrackerStorage(moduleId).getDepositedEthUpToLastSlot();
        return clBalance + pendingDeposits;
    }

    function _getModuleActiveBalance(uint256 moduleId) internal view returns (uint256) {
        return _fromGwei(moduleId.getModuleState().getStateAccounting().activeBalanceGwei);
    }

    ///  @dev get total balance of all modules + deposit tracker in ETH
    function _getTotalModulesBalance() internal view returns (uint256) {
        uint256 totalClBalance = _fromGwei(SRStorage.getRouterStorage().totalClBalanceGwei);
        uint256 pendingDeposits = SRStorage.getLidoDepositTrackerStorage().getDepositedEthUpToLastSlot();
        return totalClBalance + pendingDeposits;
    }

    function _getTotalModulesActiveBalance() internal view returns (uint256) {
        return _fromGwei(SRStorage.getRouterStorage().totalActiveBalanceGwei);
    }

    ///  @dev calculate module capacity in ETH
    function _getModuleCapacity(uint8 wcType, uint256 availableKeysCount)
        internal
        pure
        returns (uint256)
    {
        return availableKeysCount * _getModuleMEB(wcType);
    }

    function _toGwei(uint256 amount) internal pure returns (uint96) {
        amount /= 1 gwei;
        _validateAmountGwei(amount);
        return uint96(amount);
    }

    function _fromGwei(uint256 amount) internal pure returns (uint256) {
        return amount * 1 gwei;
    }
}
