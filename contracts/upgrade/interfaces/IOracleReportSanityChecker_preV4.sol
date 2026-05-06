// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24 <0.9.0;

struct LimitsList {
    uint256 exitedValidatorsPerDayLimit;
    uint256 appearedValidatorsPerDayLimit;
    uint256 annualBalanceIncreaseBPLimit;
    uint256 simulatedShareRateDeviationBPLimit;
    uint256 maxValidatorExitRequestsPerReport;
    uint256 maxItemsPerExtraDataTransaction;
    uint256 maxNodeOperatorsPerExtraDataItem;
    uint256 requestTimestampMargin;
    uint256 maxPositiveTokenRebase;
    uint256 initialSlashingAmountPWei;
    uint256 inactivityPenaltiesAmountPWei;
    uint256 clBalanceOraclesErrorUpperBPLimit;
}

// solhint-disable contract-name-capwords
interface IOracleReportSanityChecker_preV4 {
    /// @notice Returns the limits list for the Lido's oracle report sanity checks
    function getOracleReportLimits() external view returns (LimitsList memory);
}
