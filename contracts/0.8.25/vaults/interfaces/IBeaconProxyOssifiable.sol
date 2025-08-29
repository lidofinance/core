// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.0;

/**
 * @title IBeaconProxyOssifiable
 * @author Lido
 * @notice Interface for the `BeaconProxyOssifiable` contract
 */
interface IBeaconProxyOssifiable {
    function implementation() external view returns (address);
    function isOssified() external view returns (bool);
    function ossify() external;
}
