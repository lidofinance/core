// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface IHubVault {
    function valuation() external view returns (uint256);

    function inOutDelta() external view returns (int256);

    function rebalance(uint256 _ether) external payable;

    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external;
}
