// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24;

interface IVersioned {
    /// @notice Returns the current contract version.
    function getContractVersion() external view returns (uint256);
}
