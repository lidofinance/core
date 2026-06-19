// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

/// @title  IPausable
/// @notice Interface pausable contracts must implement for CircuitBreaker compatibility.
interface IPausableUntil {
    /// @notice Whether the contract is currently paused.
    function isPaused() external view returns (bool);

    /// @notice Pause the contract for a given duration.
    /// @param  _duration Duration in seconds.
    function pauseFor(uint256 _duration) external;
}
