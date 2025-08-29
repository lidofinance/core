// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.0;

/**
 * @title IOwnable2Step
 * @author Lido
 * @notice Interface for the `Ownable2Step` contract
 */
interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function acceptOwnership() external;
    function transferOwnership(address _newOwner) external;
}
