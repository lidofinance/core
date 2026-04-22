// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24;

interface IRedeemsBuffer {
    function fundReserve() external payable;
    function reconcile(uint256 _redeemedEtherForLastRefSlot, uint256 _redeemedSharesForLastRefSlot) external;
    function getRedeemed() external view returns (uint256 redeemedEther, uint256 redeemedShares);
    function getRedeemedForLastRefSlot() external view returns (uint256 redeemedEther, uint256 redeemedShares);
    function getReserveBalance() external view returns (uint256);
}
