// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

/**
 * @title CallsScriptBuilder
 * @notice A library for building call scripts in a structured manner.
 *
 * This library provides utilities to construct Aragon EVM call scripts that can be used
 * to execute multiple calls in a single transaction. It is particularly useful
 * in governance systems where a series of actions need to be executed atomically.
 *
 * The library uses a specific format to encode the calls, which includes the
 * target address, the length of the data, and the data itself. This format is
 * compatible with the Aragon OS call script specification, see SPEC_ID.
 */
library CallsScriptBuilder {
    // See https://github.com/aragon/aragonOS/pull/182
    bytes4 internal constant SPEC_ID = 0x00000001;

    struct Context {
        bytes _result; // The encoded call script result
    }

    function getResult(Context memory self) internal pure returns (bytes memory) {
        return self._result;
    }

    function create() internal pure returns (Context memory res) {
        res._result = bytes.concat(SPEC_ID);
    }

    function create(address to, bytes memory data) internal pure returns (Context memory res) {
        res = addCall(create(), to, data);
    }

    function addCall(Context memory self, address to, bytes memory data) internal pure returns (Context memory) {
        self._result = bytes.concat(self._result, bytes20(to), bytes4(uint32(data.length)), data);
        return self;
    }
}
