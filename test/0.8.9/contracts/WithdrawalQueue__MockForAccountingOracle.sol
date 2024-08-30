// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {IWithdrawalQueue} from "contracts/0.8.9/oracle/AccountingOracle.sol";

contract WithdrawalQueue__MockForAccountingOracle is IWithdrawalQueue {
    struct OnOracleReportCallData {
        bool isBunkerMode;
        uint256 prevReportTimestamp;
        uint256 currentReportTimestamp;
        uint256 callCount;
    }

    OnOracleReportCallData public lastCall__onOracleReport;

    function onOracleReport(bool isBunkerMode, uint256 prevReportTimestamp, uint256 currentReportTimestamp) external {
        lastCall__onOracleReport.isBunkerMode = isBunkerMode;
        lastCall__onOracleReport.prevReportTimestamp = prevReportTimestamp;
        lastCall__onOracleReport.currentReportTimestamp = currentReportTimestamp;
        ++lastCall__onOracleReport.callCount;
    }
}
