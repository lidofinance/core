// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {ReportValues} from "contracts/0.8.9/oracle/AccountingOracle.sol";
import {IReportReceiver} from "contracts/0.8.9/oracle/AccountingOracle.sol";

contract Accounting__MockForAccountingOracle is IReportReceiver {
    struct HandleOracleReportCallData {
        ReportValues arg;
        uint256 callCount;
    }

    HandleOracleReportCallData public lastCall__handleOracleReport;
    uint256 public totalDepositsRecorded;

    function handleOracleReport(ReportValues memory values) external override {
        lastCall__handleOracleReport = HandleOracleReportCallData(values, ++lastCall__handleOracleReport.callCount);
    }

    function recordDeposit(uint256 amount) external {
        totalDepositsRecorded += amount;
    }
}
