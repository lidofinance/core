// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

/**
 * @notice Interface for zero argument errors
 */
interface IZeroArgument {
    /**
     * @notice Error thrown for zero address arguments
     * @param argument Name of the argument that is zero
     */
    error ZeroArgument(string argument);
}
