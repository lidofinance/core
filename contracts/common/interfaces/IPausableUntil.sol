// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

interface IPausableUntil {
    // Errors
    error ZeroPauseDuration();
    error PausedExpected();
    error ResumedExpected();
    error PauseUntilMustBeInFuture();

    // Events
    event Paused(uint256 duration);
    event Resumed();

    // Constants (external view functions for public constants)
    function PAUSE_INFINITELY() external view returns (uint256);

    // External functions
    function isPaused() external view returns (bool);
    function getResumeSinceTimestamp() external view returns (uint256);
}