// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import { MemUtils } from "../../common/lib/MemUtils.sol";


library Assert {
    error RevertExpected();
    error AssertFailed(bool actual, bool expected);
    error AssertEqualFailed_uint256(uint256 actual, uint256 expected);
    error AssertEqualFailed_bytes32(bytes32 actual, bytes32 expected);
    error AssertEqualFailed_bytes(bytes actual, bytes expected);
    error AssertEqualFailed_uint256arr(uint256[] actual, uint256[] expected);
    error AssertMemoryFailed(bytes actual, bytes expected);
    error AssertLengthFailed(uint256 actual, uint256 expected);
    error AssertAboveFailed(uint256 shouldBeAbove, uint256 compareTo);
    error AssertAtLeastFailed(uint256 shouldBeAtLeast, uint256 compareTo);

    function isTrue(bool value) internal pure {
        if (!value) {
            revert AssertFailed(false, true);
        }
    }

    function isFalse(bool value) internal pure {
        if (value) {
            revert AssertFailed(true, false);
        }
    }

    function equal(uint256 actual, uint256 expected) internal pure {
        if (actual != expected) {
            revert AssertEqualFailed_uint256(actual, expected);
        }
    }

    function equal(bytes32 actual, bytes32 expected) internal pure {
        if (actual != expected) {
            revert AssertEqualFailed_bytes32(actual, expected);
        }
    }

    function equal(bytes memory actual, bytes memory expected) internal pure {
        if (memKeccak(actual) != memKeccak(expected)) {
            revert AssertEqualFailed_bytes(actual, expected);
        }
    }

    function equal(uint256[] memory actual, uint256[] memory expected) internal pure {
        if (actual.length != expected.length) {
            revert AssertEqualFailed_uint256arr(actual, expected);
        }
        if (memKeccak(actual) != memKeccak(expected)) {
            revert AssertEqualFailed_uint256arr(actual, expected);
        }
    }

    function mem(uint256 start, uint256 pastEnd, bytes memory expected) internal pure {
        // don't use this assertion for testing MemUtils.memcpy as it uses that same function
        if (memKeccak(start, pastEnd) != memKeccak(expected)) {
            bytes memory actual = new bytes(pastEnd - start);
            MemUtils.memcpy(start, getMemPtr(actual) + 32, pastEnd - start);
            revert AssertMemoryFailed(actual, expected);
        }
    }

    function length(uint256[] memory actual, uint256 expectedLen) internal pure {
        if (actual.length != expectedLen) {
            revert AssertLengthFailed(actual.length, expectedLen);
        }
    }

    function length(bytes memory actual, uint256 expectedLen) internal pure {
        if (actual.length != expectedLen) {
            revert AssertLengthFailed(actual.length, expectedLen);
        }
    }

    function empty(uint256[] memory actual) internal pure {
        length(actual, 0);
    }

    function empty(bytes memory actual) internal pure {
        length(actual, 0);
    }

    function atLeast(uint256 shouldBeAtLeast, uint256 compareTo) internal pure {
        if (shouldBeAtLeast < compareTo) {
            revert AssertAtLeastFailed(shouldBeAtLeast, compareTo);
        }
    }

    function above(uint256 shouldBeAbove, uint256 compareTo) internal pure {
        if (shouldBeAbove <= compareTo) {
            revert AssertAboveFailed(shouldBeAbove, compareTo);
        }
    }
}

/* solhint-disable func-visibility */
// solhint does not understand free functions https://github.com/protofire/solhint/issues/276
function memKeccak(uint256 start, uint256 pastEnd) pure returns (bytes32 result) {
    uint256 len = pastEnd - start;
    assembly {
        result := keccak256(start, len)
    }
}

function memKeccak(bytes memory arr) pure returns (bytes32 result) {
    assembly {
        result := keccak256(add(arr, 32), mload(arr))
    }
}

function memKeccak(uint256[] memory arr) pure returns (bytes32 result) {
    assembly {
        result := keccak256(add(arr, 32), mul(mload(arr), 32))
    }
}


// Address of the memory "zero slot"
// https://docs.soliditylang.org/en/v0.8.9/internals/layout_in_memory.html
uint256 constant ZERO_MEM_SLOT_PTR = 96;

function getFreeMemPtr() pure returns (uint256 result) {
    assembly {
        result := mload(0x40)
    }
}

function incrementFreeMemPtr(uint256 inc) pure returns (uint256 freeMemPtr) {
    assembly {
        freeMemPtr := add(mload(0x40), inc)
        mstore(0x40, freeMemPtr)
    }
}

function getMemPtr(bytes memory arr) pure returns (uint256 result) {
    assembly {
        result := arr
    }
}


function dyn(uint256[1] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](1);
    result[0] = arr[0];
}

function dyn(uint256[2] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](2);
    result[0] = arr[0];
    result[1] = arr[1];
}

function dyn(uint256[3] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](3);
    result[0] = arr[0];
    result[1] = arr[1];
    result[2] = arr[2];
}

function dyn(uint256[4] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](4);
    for (uint256 i = 0; i < 4; ++i) {
        result[i] = arr[i];
    }
}

function dyn(uint256[5] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](5);
    for (uint256 i = 0; i < 5; ++i) {
        result[i] = arr[i];
    }
}

function dyn(uint256[6] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](6);
    for (uint256 i = 0; i < 6; ++i) {
        result[i] = arr[i];
    }
}

function dyn(uint256[7] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](7);
    for (uint256 i = 0; i < 7; ++i) {
        result[i] = arr[i];
    }
}

function dyn(uint256[8] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](8);
    for (uint256 i = 0; i < 8; ++i) {
        result[i] = arr[i];
    }
}

function dyn(uint256[9] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](9);
    for (uint256 i = 0; i < 9; ++i) {
        result[i] = arr[i];
    }
}

function dyn(uint256[10] memory arr) pure returns (uint256[] memory result) {
    result = new uint256[](10);
    for (uint256 i = 0; i < 10; ++i) {
        result[i] = arr[i];
    }
}
/* solhint-enable func-visibility */
