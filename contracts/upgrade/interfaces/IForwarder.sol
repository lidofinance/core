// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24 <0.9.0;

interface IForwarder {
    function execute(address _target, uint256 _ethValue, bytes memory _data) external payable;
    function forward(bytes memory _evmScript) external;
}
