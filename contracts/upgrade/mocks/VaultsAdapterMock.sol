// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;


/**
 * @title VaultsAdapterMock
 * @notice Stores immutable addresses required for the V3 upgrade process.
 * This contract centralizes address management for V3Template and V3VoteScript.
 */
contract VaultsAdapterMock {

    address public immutable EVM_SCRIPT_EXECUTOR;

    constructor(address _evmScriptExecutor) {
        EVM_SCRIPT_EXECUTOR = _evmScriptExecutor;
    }

    function evmScriptExecutor() external view returns (address) {
        return EVM_SCRIPT_EXECUTOR;
    }

}
