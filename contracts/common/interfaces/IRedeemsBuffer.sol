// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24;

interface IRedeemsBuffer {
    function fundReserve() external payable;
    function withdrawUnredeemed(uint256 _settledEther) external;
    function getRedeemedEther() external view returns (uint256);
    function getRedeemedEtherForReport() external view returns (uint256);
    function getReserveBalance() external view returns (uint256);
}
