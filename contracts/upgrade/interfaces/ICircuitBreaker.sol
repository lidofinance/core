// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: UNLICENSED

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

interface ICircuitBreaker {
    function registerPauser(address _pausable, address _newPauser) external;
    function getPauser(address _pausable) external view returns (address);
}
