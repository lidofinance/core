// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.0;

/**
 * @title IPinnedBeaconProxy
 * @author Lido
 * @notice Interface for the `PinnedBeaconProxy` contract
 */
interface IPinnedBeaconProxy {
    function isOssified() external view returns (bool);
}
