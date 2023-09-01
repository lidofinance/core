// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { IWithdrawalQueue } from "../../oracle/AccountingOracle.sol";

contract MockWithdrawalQueueForAccountingOracle is IWithdrawalQueue {
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
