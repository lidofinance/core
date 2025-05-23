// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

library CallsScriptBuilder {
    // See https://github.com/aragon/aragonOS/pull/182
    bytes4 internal constant SPEC_ID = 0x00000001;

    struct Context {
        bytes _result;
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
