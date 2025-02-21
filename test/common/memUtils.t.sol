// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.4.24 <0.9.0;

import "forge-std/Test.sol";

import {MemUtils} from "contracts/common/lib/MemUtils.sol";

import {MemUtilsTestHelper} from "test/common/memUtils.h.sol";

contract MemUtilsTest is Test, MemUtilsTestHelper {
    function test_unsafeAllocateBytes_AllocatesEmptyByteArray() external pure {
        // disable all compiler optimizations by including an assembly block not marked as mem-safe
        assembly {
            mstore(0x00, 0x1)
        }

        uint256 preAllocFreeMemPtr = getFreeMemPtr();

        // assert free mem pointer is 32-byte aligned initially
        assertTrue(preAllocFreeMemPtr % 32 == 0);

        bytes memory arr = MemUtils.unsafeAllocateBytes(0);
        assertEq(arr.length, 0);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        uint256 freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32);
    }

    function test_unsafeAllocateBytes_AllocatesMemoryAndAdvancesFreeMemPointer() external pure {
        // disable all compiler optimizations by including an assembly block not marked as mem-safe
        assembly {
            mstore(0x00, 0x1)
        }

        uint256 initialFreeMemPtr = getFreeMemPtr();
        uint256 preAllocFreeMemPtr = initialFreeMemPtr;

        // assert free mem pointer is 32-byte aligned initially
        assertTrue(preAllocFreeMemPtr % 32 == 0);

        bytes memory arr = MemUtils.unsafeAllocateBytes(32);
        assertEq(arr.length, 32);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);
        fill(arr, 0x11);

        uint256 freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 32);
        preAllocFreeMemPtr = freeMemPtr;

        arr = MemUtils.unsafeAllocateBytes(64);
        assertEq(arr.length, 64);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);
        fill(arr, 0x22);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 64);
        preAllocFreeMemPtr = freeMemPtr;

        arr = MemUtils.unsafeAllocateBytes(32 * 10);
        assertEq(arr.length, 32 * 10);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);
        fill(arr, 0x33);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 32 * 10);
        preAllocFreeMemPtr = freeMemPtr;

        arr = MemUtils.unsafeAllocateBytes(32 * 100);
        assertEq(arr.length, 32 * 100);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);
        fill(arr, 0x44);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 32 * 100);

        mem(
            initialFreeMemPtr,
            freeMemPtr,
            abi.encodePacked(
                // array 1: length
                uint256(32),
                // array 1: data
                bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
                // array 2: length
                uint256(64),
                // array 2: data
                bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
                bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
                // array 3: length
                uint256(32 * 10),
                // array 3: data
                fill(new bytes(32 * 10), 0x33),
                // array 3: length
                uint256(32 * 100),
                // array 3: data
                fill(new bytes(32 * 100), 0x44)
            )
        );
    }

    function test_unsafeAllocateBytes_PadsFreeMemPointerTo32Bytes() external pure {
        // disable all compiler optimizations by including an assembly block not marked as mem-safe
        assembly {
            mstore(0x00, 0x1)
        }

        uint256 preAllocFreeMemPtr = getFreeMemPtr();

        // assert free mem pointer is 32-byte aligned initially
        assertTrue(preAllocFreeMemPtr % 32 == 0);

        bytes memory arr = MemUtils.unsafeAllocateBytes(1);
        assertEq(arr.length, 1);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        uint256 freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 32);
        preAllocFreeMemPtr = freeMemPtr;

        arr = MemUtils.unsafeAllocateBytes(20);
        assertEq(arr.length, 20);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 32);
        preAllocFreeMemPtr = freeMemPtr;

        arr = MemUtils.unsafeAllocateBytes(60);
        assertEq(arr.length, 60);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 64);
        preAllocFreeMemPtr = freeMemPtr;

        arr = MemUtils.unsafeAllocateBytes(32 * 10 + 1);
        assertEq(arr.length, 32 * 10 + 1);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 32 * 11);
        preAllocFreeMemPtr = freeMemPtr;

        arr = MemUtils.unsafeAllocateBytes(32 * 100 + 15);
        assertEq(arr.length, 32 * 100 + 15);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 32 * 101);
    }

    function test_unsafeAllocateBytes_HandlesMisalignedFreeMemPointerAndPadsTo32Bytes() external pure {
        uint256 freeMemPtr = getFreeMemPtr();

        // assert free mem pointer is 32-byte aligned initially
        assertTrue(freeMemPtr % 32 == 0);

        // misalign the free mem pointer
        uint256 preAllocFreeMemPtr = incrementFreeMemPtr(3);

        bytes memory arr = MemUtils.unsafeAllocateBytes(32);
        assertEq(arr.length, 32);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, (preAllocFreeMemPtr + 32 - 3) + 32 + 32);

        // misalign the free mem pointer
        preAllocFreeMemPtr = incrementFreeMemPtr(1);

        arr = MemUtils.unsafeAllocateBytes(120);
        assertEq(arr.length, 120);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, (preAllocFreeMemPtr - 1) + 32 + 128);

        // misalign the free mem pointer
        preAllocFreeMemPtr = incrementFreeMemPtr(32 - 12);

        arr = MemUtils.unsafeAllocateBytes(128 + 12);
        assertEq(arr.length, 128 + 12);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + 32 + 128 + 12);

        // misalign the free mem pointer
        preAllocFreeMemPtr = incrementFreeMemPtr(5);

        arr = MemUtils.unsafeAllocateBytes(0);
        assertEq(arr.length, 0);
        assertEq(getMemPtr(arr), preAllocFreeMemPtr);

        freeMemPtr = getFreeMemPtr();
        assertEq(freeMemPtr, preAllocFreeMemPtr + (32 - 5) + 32);
    }

    function test_memcpy_CopiesMemChunksThatAreMultiplesOf32Bytes() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444),
            bytes32(0x5555555555555555555555555555555555555555555555555555555555555555)
        );

        MemUtils.memcpy(getDataPtr(src), getDataPtr(dst), 64);

        assertEq(
            dst,
            abi.encodePacked(
                bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
                bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
                bytes32(0x5555555555555555555555555555555555555555555555555555555555555555)
            )
        );
    }

    function test_memcpy_CopiesMemChunksThatAreMultiplesOf32BytesFromANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444),
            bytes32(0x5555555555555555555555555555555555555555555555555555555555555555),
            bytes32(0x6666666666666666666666666666666666666666666666666666666666666666)
        );

        MemUtils.memcpy(getDataPtr(src) + 4, getDataPtr(dst), 64);

        assertEq(
            dst,
            abi.encodePacked(
                bytes32(0x1111111111111111111111111111111111111111111111111111111122222222),
                bytes32(0x2222222222222222222222222222222222222222222222222222222233333333),
                bytes32(0x6666666666666666666666666666666666666666666666666666666666666666)
            )
        );
    }

    function test_memcpy_CopiesMemChunksThatAreMultiplesOf32BytesToANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444),
            bytes32(0x5555555555555555555555555555555555555555555555555555555555555555)
        );

        MemUtils.memcpy(getDataPtr(src), getDataPtr(dst) + 4, 64);

        assertEq(
            dst,
            abi.encodePacked(
                bytes32(0x3333333311111111111111111111111111111111111111111111111111111111),
                bytes32(0x1111111122222222222222222222222222222222222222222222222222222222),
                bytes32(0x2222222255555555555555555555555555555555555555555555555555555555)
            )
        );
    }

    function test_memcpy_CopiesMemChunksThatAreMultiplesOf32BytesFromAndToANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444),
            bytes32(0x5555555555555555555555555555555555555555555555555555555555555555),
            bytes32(0x6666666666666666666666666666666666666666666666666666666666666666)
        );

        MemUtils.memcpy(getDataPtr(src) + 4, getDataPtr(dst) + 3, 64);

        assertEq(
            dst,
            abi.encodePacked(
                bytes32(0x4444441111111111111111111111111111111111111111111111111111111122),
                bytes32(0x2222222222222222222222222222222222222222222222222222222222222233),
                bytes32(0x3333336666666666666666666666666666666666666666666666666666666666)
            )
        );
    }

    function test_memcpy_CopiesMemChunksThatAreNotMultiplesOf32Bytes() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444)
        );

        MemUtils.memcpy(getDataPtr(src), getDataPtr(dst), 42);

        assertEq(
            dst,
            abi.encodePacked(
                bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
                bytes32(0x2222222222222222222244444444444444444444444444444444444444444444)
            )
        );
    }

    function test_memcpy_CopiesMemChunksThatAreNotMultiplesOf32BytesFromANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444)
        );

        MemUtils.memcpy(getDataPtr(src) + 3, getDataPtr(dst), 42);

        assertEq(
            dst,
            abi.encodePacked(
                bytes32(0x1111111111111111111111111111111111111111111111111111111111222222),
                bytes32(0x2222222222222222222244444444444444444444444444444444444444444444)
            )
        );
    }

    function test_memcpy_CopiesMemChunksThatAreNotMultiplesOf32BytesToANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444)
        );

        MemUtils.memcpy(getDataPtr(src), getDataPtr(dst) + 3, 42);

        assertEq(
            dst,
            abi.encodePacked(
                bytes32(0x3333331111111111111111111111111111111111111111111111111111111111),
                bytes32(0x1111112222222222222222222244444444444444444444444444444444444444)
            )
        );
    }

    function test_memcpy_CopiesMemChunksThatAreNotMultiplesOf32BytesFromAndToANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444)
        );

        MemUtils.memcpy(getDataPtr(src) + 3, getDataPtr(dst) + 4, 42);

        assertEq(
            dst,
            abi.encodePacked(
                bytes32(0x3333333311111111111111111111111111111111111111111111111111111111),
                bytes32(0x1122222222222222222222222222444444444444444444444444444444444444)
            )
        );
    }

    function test_memcpy_CopiesMemChunksShorterThan32Bytes() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        MemUtils.memcpy(getDataPtr(src), getDataPtr(dst), 5);

        assertEq(dst, abi.encodePacked(bytes32(0x1111111111222222222222222222222222222222222222222222222222222222)));
    }

    function test_memcpy_CopiesMemChunksShorterThan32BytesFromANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0xcccccccccccccccccccccccccccccccccc8badf00d1234eeeeeeeeeeeeeeeeee)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        MemUtils.memcpy(getDataPtr(src) + 17, getDataPtr(dst), 4);

        assertEq(dst, abi.encodePacked(bytes32(0x8badf00d22222222222222222222222222222222222222222222222222222222)));
    }

    function test_memcpy_CopiesMemChunksShorterThan32BytesToANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        MemUtils.memcpy(getDataPtr(src), getDataPtr(dst) + 5, 5);

        assertEq(dst, abi.encodePacked(bytes32(0x2222222222111111111122222222222222222222222222222222222222222222)));
    }

    function test_memcpy_CopiesMemChunksShorterThan32BytesFromAndToANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0xcccccccccccccccccccccccccccccccccc8badf00d1234eeeeeeeeeeeeeeeeee)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        MemUtils.memcpy(getDataPtr(src) + 17, getDataPtr(dst) + 3, 4);

        assertEq(dst, abi.encodePacked(bytes32(0x2222228badf00d22222222222222222222222222222222222222222222222222)));
    }

    function test_memcpy_HandlesZeroLength() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        MemUtils.memcpy(getDataPtr(src) + 11, getDataPtr(dst) + 13, 0);

        assertEq(dst, abi.encodePacked(bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)));
    }

    function test_copyBytes_CopiesMemChunksThatAreMultiplesOf32Bytes() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        MemUtils.copyBytes(src, dst, 0);

        assertEq(dst, abi.encodePacked(bytes32(0x1111111111111111111111111111111111111111111111111111111111111111)));
    }

    function test_copyBytes_CopiesMemChunksThatAreMultiplesOf32BytesFromANon32BytesOffset() external pure {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        MemUtils.copyBytes(src, dst, 1, 1, 31);

        assertEq(dst, abi.encodePacked(bytes32(0x2211111111111111111111111111111111111111111111111111111111111111)));
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_copyBytes_RevertsWhenSrcArrayIsOutOfBounds() external {
        bytes memory src = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111)
        );

        bytes memory dst = abi.encodePacked(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        vm.expectRevert(bytes("BYTES_ARRAY_OUT_OF_BOUNDS"));
        MemUtils.copyBytes(src, dst, 1, 1, 32);
    }
}
