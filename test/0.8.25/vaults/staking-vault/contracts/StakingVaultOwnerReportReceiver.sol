// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import { IReportReceiver } from "contracts/0.8.25/vaults/interfaces/IReportReceiver.sol";

contract StakingVaultOwnerReportReceiver is IReportReceiver {
    event Mock__ReportReceived(uint256 _valuation, int256 _inOutDelta, uint256 _locked);

    error Mock__ReportReverted();

    bool public reportShouldRevert = false;
    bool public reportShouldRunOutOfGas = false;

    function setReportShouldRevert(bool _reportShouldRevert) external {
        reportShouldRevert = _reportShouldRevert;
    }

    function setReportShouldRunOutOfGas(bool _reportShouldRunOutOfGas) external {
        reportShouldRunOutOfGas = _reportShouldRunOutOfGas;
    }

    function onReport(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        if (reportShouldRevert) revert Mock__ReportReverted();

        if (reportShouldRunOutOfGas) {
            for (uint256 i = 0; i < 1000000000; i++) {
                keccak256(abi.encode(i));
            }
        }

        emit Mock__ReportReceived(_valuation, _inOutDelta, _locked);
    }
}
