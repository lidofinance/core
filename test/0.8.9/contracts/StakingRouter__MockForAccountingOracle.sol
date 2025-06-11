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
}
