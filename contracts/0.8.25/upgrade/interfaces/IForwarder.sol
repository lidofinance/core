// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

interface IForwarder {
    function execute(address _target, uint256 _ethValue, bytes memory _data) external payable;
    function forward(bytes memory _evmScript) external;
}
