// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

/// @notice Minimal stub for IEVMScriptFactory.
contract EasyTrackFactoryMock {
    function createEVMScript(address _creator, bytes memory _evmScriptCallData) external returns (bytes memory) {
        return _evmScriptCallData;
    }
}
