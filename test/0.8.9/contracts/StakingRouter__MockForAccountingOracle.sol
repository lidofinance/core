// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {IStakingRouter} from "contracts/0.8.9/oracle/AccountingOracle.sol";

contract StakingRouter__MockForAccountingOracle is IStakingRouter {
    error InvalidValidatorBalancesReport();

    struct UpdateExitedKeysByModuleCallData {
        uint256[] moduleIds;
        uint256[] exitedKeysCounts;
        uint256 callCount;
    }

    struct ReportKeysByNodeOperatorCallData {
        uint256 stakingModuleId;
        bytes nodeOperatorIds;
        bytes keysCounts;
    }

    mapping(uint256 => uint256) internal _exitedKeysCountsByModuleId;
    mapping(uint256 => uint256) internal _moduleBalancesWei;
    mapping(uint256 => uint64) internal _validatorBalancesGweiByModuleId;
    mapping(uint256 => uint64) internal _pendingBalancesGweiByModuleId;
    mapping(uint256 => bool) internal _moduleExistsById;
    uint256[] internal _registeredModuleIds;

    uint256 internal _totalStakingModulesBalanceWei;

    UpdateExitedKeysByModuleCallData internal _lastCall_updateExitedKeysByModule;

    ReportKeysByNodeOperatorCallData[] public calls_reportExitedKeysByNodeOperator;

    uint256 public totalCalls_onValidatorsCountsByNodeOperatorReportingFinished;

    function lastCall_updateExitedKeysByModule() external view returns (UpdateExitedKeysByModuleCallData memory) {
        return _lastCall_updateExitedKeysByModule;
    }

    function totalCalls_reportExitedKeysByNodeOperator() external view returns (uint256) {
        return calls_reportExitedKeysByNodeOperator.length;
    }

    ///
    /// IStakingRouter
    ///

    function mock__registerStakingModule(uint256 moduleId) external {
        if (_moduleExistsById[moduleId]) {
            return;
        }

        _moduleExistsById[moduleId] = true;
        _registeredModuleIds.push(moduleId);
    }

    function updateExitedValidatorsCountByStakingModule(
        uint256[] calldata moduleIds,
        uint256[] calldata exitedKeysCounts
    ) external returns (uint256) {
        _lastCall_updateExitedKeysByModule.moduleIds = moduleIds;
        _lastCall_updateExitedKeysByModule.exitedKeysCounts = exitedKeysCounts;
        ++_lastCall_updateExitedKeysByModule.callCount;

        uint256 newlyExitedValidatorsCount;

        for (uint256 i = 0; i < moduleIds.length; ++i) {
            uint256 moduleId = moduleIds[i];
            newlyExitedValidatorsCount += exitedKeysCounts[i] - _exitedKeysCountsByModuleId[moduleId];
            _exitedKeysCountsByModuleId[moduleId] = exitedKeysCounts[i];
            _moduleExistsById[moduleId] = true;
        }

        return newlyExitedValidatorsCount;
    }

    function reportValidatorBalancesByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _validatorBalancesGwei
    ) external {
        this.validateReportValidatorBalancesByStakingModule(_stakingModuleIds, _validatorBalancesGwei);

        uint256 totalBalance = _totalStakingModulesBalanceWei;
        for (uint256 i = 0; i < _stakingModuleIds.length; ++i) {
            uint256 moduleId = _stakingModuleIds[i];
            uint256 previousBalance = _moduleBalancesWei[moduleId];
            uint256 currentBalance = (_validatorBalancesGwei[i]) * 1 gwei;

            if (currentBalance >= previousBalance) {
                totalBalance += currentBalance - previousBalance;
            } else {
                totalBalance -= previousBalance - currentBalance;
            }

            _moduleBalancesWei[moduleId] = currentBalance;
            _validatorBalancesGweiByModuleId[moduleId] = uint64(_validatorBalancesGwei[i]);
            _moduleExistsById[moduleId] = true;
        }
        _totalStakingModulesBalanceWei = totalBalance;
    }

    function validateReportValidatorBalancesByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _validatorBalancesGwei
    ) external view {
        uint256 modulesCount = _registeredModuleIds.length;
        if (_stakingModuleIds.length != modulesCount || _validatorBalancesGwei.length != modulesCount) {
            revert InvalidValidatorBalancesReport();
        }

        for (uint256 i = 0; i < modulesCount; ++i) {
            if (_stakingModuleIds[i] != _registeredModuleIds[i]) {
                revert InvalidValidatorBalancesReport();
            }
            if (_validatorBalancesGwei[i] > type(uint64).max) {
                revert InvalidValidatorBalancesReport();
            }
        }
    }

    function getDepositAmountFromLastSlot(uint256) external view returns (uint256) {
        return 0;
    }

    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 stakingModuleId,
        bytes calldata nodeOperatorIds,
        bytes calldata exitedKeysCounts
    ) external {
        calls_reportExitedKeysByNodeOperator.push(
            ReportKeysByNodeOperatorCallData(stakingModuleId, nodeOperatorIds, exitedKeysCounts)
        );
    }

    function onValidatorsCountsByNodeOperatorReportingFinished() external {
        ++totalCalls_onValidatorsCountsByNodeOperatorReportingFinished;
    }

    function getModuleValidatorsBalance(uint256 moduleId) external view returns (uint256) {
        return _moduleBalancesWei[moduleId];
    }

    function hasStakingModule(uint256 moduleId) external view returns (bool) {
        return _moduleExistsById[moduleId];
    }

    function getStakingModuleStateAccounting(
        uint256 moduleId
    ) external view returns (uint64 validatorsBalanceGwei, uint64 exitedValidatorsCount) {
        return (_validatorBalancesGweiByModuleId[moduleId], uint64(_exitedKeysCountsByModuleId[moduleId]));
    }

    function getTotalModulesValidatorsBalance() external view returns (uint256) {
        return _totalStakingModulesBalanceWei;
    }
}
