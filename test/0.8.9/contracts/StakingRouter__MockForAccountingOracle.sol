// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {IStakingRouter} from "contracts/0.8.9/oracle/AccountingOracle.sol";

contract StakingRouter__MockForAccountingOracle is IStakingRouter {
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
        }

        return newlyExitedValidatorsCount;
    }

    function reportValidatorBalancesByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _validatorBalancesGwei,
        uint256[] calldata _pendingBalancesGwei
    ) external {
        uint256 totalBalance = _totalStakingModulesBalanceWei;
        for (uint256 i = 0; i < _stakingModuleIds.length; ++i) {
            uint256 moduleId = _stakingModuleIds[i];
            uint256 previousBalance = _moduleBalancesWei[moduleId];
            uint256 currentBalance = (_activeBalancesGwei[i] + _pendingBalancesGwei[i]) * 1 gwei;

            if (currentBalance >= previousBalance) {
                totalBalance += currentBalance - previousBalance;
            } else {
                totalBalance -= previousBalance - currentBalance;
            }

            _moduleBalancesWei[moduleId] = currentBalance;
        }
        _totalStakingModulesBalanceWei = totalBalance;
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

    function reportStakingModuleOperatorBalances(
        uint256 _stakingModuleId,
        bytes calldata _operatorIds,
        bytes calldata _totalBalancesGwei
    ) external {
        calls_reportExitedKeysByNodeOperator.push(
            ReportKeysByNodeOperatorCallData(_stakingModuleId, _operatorIds, _totalBalancesGwei)
        );
    }

    function onValidatorsCountsByNodeOperatorReportingFinished() external {
        ++totalCalls_onValidatorsCountsByNodeOperatorReportingFinished;
    }

    function getStakingModuleBalance(uint256 moduleId) external view returns (uint256) {
        return _moduleBalancesWei[moduleId];
    }

    function getTotalStakingModulesBalance() external view returns (uint256) {
        return _totalStakingModulesBalanceWei;
    }
}
