// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: UNLICENSED

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

interface IUpgradeTemplate {
    function CONFIG() external view returns (address);
    function isUpgradeFinished() external view returns (bool);
}
