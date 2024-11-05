// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface IReportReceiver {
    function onReport(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external;
}
