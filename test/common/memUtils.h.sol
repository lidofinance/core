// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.4.24 <0.9.0;

import {MemUtils} from "contracts/common/lib/MemUtils.sol";

contract MemUtilsTestHelper {
    uint256 internal constant ZERO_MEM_SLOT_PTR = 96;

    error AssertMemoryFailed(bytes actual, bytes expected);

    function memKeccak(uint256 start, uint256 pastEnd) internal pure returns (bytes32 result) {
        uint256 len = pastEnd - start;
        assembly {
            result := keccak256(start, len)
        }
    }

    function memKeccak(bytes memory arr) internal pure returns (bytes32 result) {
        assembly {
            result := keccak256(add(arr, 32), mload(arr))
        }
    }

    // don't use this assertion for testing MemUtils.memcpy as it uses that same function
    function mem(uint256 _start, uint256 _pastEnd, bytes memory _expected) internal pure {
        if (memKeccak(_start, _pastEnd) != memKeccak(_expected)) {
            bytes memory actual = new bytes(_pastEnd - _start);
            MemUtils.memcpy(_start, getMemPtr(actual) + 32, _pastEnd - _start);
            revert AssertMemoryFailed(actual, _expected);
        }
    }

    function getMemPtr(bytes memory arr) internal pure returns (uint256 result) {
        assembly {
            result := arr
        }
    }

    function getDataPtr(bytes memory arr) internal pure returns (uint256 dataPtr) {
        assembly {
            dataPtr := add(arr, 32)
        }
    }

    function getFreeMemPtr() internal pure returns (uint256 result) {
        assembly {
            result := mload(0x40)
        }
    }

    function incrementFreeMemPtr(uint256 inc) internal pure returns (uint256 freeMemPtr) {
        assembly {
            freeMemPtr := add(mload(0x40), inc)
            mstore(0x40, freeMemPtr)
        }
    }

    function fill(bytes memory arr, bytes1 value) internal pure returns (bytes memory) {
        for (uint256 i = 0; i < arr.length; ++i) {
            arr[i] = value;
        }
        return arr;
    }
}
