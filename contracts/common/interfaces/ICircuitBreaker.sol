// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

// https://github.com/lidofinance/circuit-breaker/blob/b4b2fbc921b3191560a3fc62d502d4bb98ad99e1/src/CircuitBreaker.sol
interface ICircuitBreaker {
    function pause(address _pausable) external;
    function registerPauser(address _pausable, address _newPauser) external;
    function getPauser(address _pausable) external view returns (address);
}
