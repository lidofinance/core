// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import { IReportReceiver } from "contracts/0.8.25/vaults/interfaces/IReportReceiver.sol";

contract StakingVaultOwnerReportReceiver is IReportReceiver {
    event Mock__ReportReceived(uint256 _valuation, int256 _inOutDelta, uint256 _locked);

    error Mock__ReportReverted();

    bool public reportShouldRevert = false;

    function setReportShouldRevert(bool _reportShouldRevert) external {
        reportShouldRevert = _reportShouldRevert;
    }

    function onReport(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        if (reportShouldRevert) revert Mock__ReportReverted();

        emit Mock__ReportReceived(_valuation, _inOutDelta, _locked);
    }
}
