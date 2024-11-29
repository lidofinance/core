// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface IBeaconProxy {
    function getBeacon() external view returns (address);
    function version() external pure returns(uint64);
}
