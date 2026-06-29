// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

/// @notice Helper contract to stub EVMScriptExecutor
contract EasyTrackEVMScriptExecutorStub {
    bytes public evmScript;

    function executeEVMScript(bytes memory _evmScript) external returns (bytes memory) {
        return _evmScript;
    }
}
