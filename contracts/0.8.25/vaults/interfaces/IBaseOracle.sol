// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

interface IBaseOracle {
    /// @notice Returns the address of the consensus contract
    /// @return The address of the consensus contract
    function getConsensusContract() external view returns (address);
} 
