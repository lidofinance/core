// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

/// @title Second Opinion Oracle interface for Lido. See LIP-39 for details.
interface ISecondOpinionOracle {
    /// @notice Returns the independently confirmed Accounting Oracle report hash for a reference slot.
    function getReportHash(uint256 refSlot) external view returns (bool exists, bytes32 reportHash);
}
