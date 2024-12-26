// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {Memory} from "contracts/0.8.25/lib/Memory.sol";

// TODO: MORE TESTS
contract MemoryLibTest is Test {
    // Test alloc()
    function test_alloc() public pure {
        bytes memory result = Memory.alloc(100);
        assert(result.length == 100);
    }

    function test_RevertIfAllocationLengthIsZero() public {
        vm.expectRevert(Memory.AllocationLengthZero.selector);
        Memory.alloc(0);
    }

    // Test copy()
    function test_copyOneByte() public pure {
        bytes memory src = new bytes(1);
        bytes memory dst = new bytes(1);

        src[0] = 0x01;

        // assert first byte of src is 0x01
        assertEq(uint8(src[0]), 0x01);
        // assert first byte of dst is 0x00
        assertEq(uint8(dst[0]), 0x00);

        // copy first byte of src to dst
        Memory.copy(src, dst, 0, 0, 1);

        // assert first byte of dst is now 0x01
        assertEq(uint8(dst[0]), 0x01);
        // assert first byte of src is still 0x01
        assertEq(uint8(src[0]), 0x01);
    }

    function test_copy_withSourceOffset() public pure {
        bytes memory src = new bytes(2);
        bytes memory dst = new bytes(2);

        src[1] = 0x01;

        // assert first byte of src is 0x01
        assertEq(uint8(src[1]), 0x01);
        assertEq(uint8(src[0]), 0x00);
        // assert first byte of dst is 0x00
        assertEq(uint8(dst[0]), 0x00);
        assertEq(uint8(dst[1]), 0x00);

        // copy second byte of src to first byte of dst
        Memory.copy(src, dst, 1, 0, 1);

        assertEq(uint8(dst[0]), 0x01);
        assertEq(uint8(dst[1]), 0x00);
        assertEq(uint8(src[0]), 0x00);
        assertEq(uint8(src[1]), 0x01);
    }

    function test_copy_withDestinationOffset() public pure {
        bytes memory src = new bytes(2);
        bytes memory dst = new bytes(2);

        src[0] = 0x01;

        // assert first byte of src is 0x01
        assertEq(uint8(src[0]), 0x01);
        // assert first byte of dst is 0x00
        assertEq(uint8(dst[0]), 0x00);

        // copy first byte of src to second byte of dst
        Memory.copy(src, dst, 0, 1, 1);

        // assert first byte of dst is now 0x01
        assertEq(uint8(dst[1]), 0x01);
        // assert first byte of src is still 0x01
        assertEq(uint8(src[0]), 0x01);
    }

    function test_copy_withOffsets() public pure {
        bytes memory src = new bytes(2);
        bytes memory dst = new bytes(2);

        src[0] = 0x01;
        src[1] = 0x02;

        // assert first byte of src is 0x01
        assertEq(uint8(src[0]), 0x01);
        // assert second byte of src is 0x02
        assertEq(uint8(src[1]), 0x02);
        // assert first byte of dst is 0x00
        assertEq(uint8(dst[0]), 0x00);
        // assert second byte of dst is 0x00
        assertEq(uint8(dst[1]), 0x00);

        // copy second byte of src to second byte of dst
        Memory.copy(src, dst, 1, 1, 1);

        assertEq(uint8(dst[0]), 0x00);
        assertEq(uint8(dst[1]), 0x02);
        assertEq(uint8(src[0]), 0x01);
        assertEq(uint8(src[1]), 0x02);
    }

    function test_copy_RevertIfSourceOffsetIsEqualOrGreaterThanSourceLength() public {
        bytes memory src = new bytes(1);
        bytes memory dst = new bytes(1);

        vm.expectRevert(Memory.InvalidSourceOffset.selector);
        Memory.copy(src, dst, src.length, 0, 1);
    }

    function test_copy_RevertIfDestinationOffsetIsEqualOrGreaterThanDestinationLength() public {
        bytes memory src = new bytes(1);
        bytes memory dst = new bytes(1);

        vm.expectRevert(Memory.InvalidDestinationOffset.selector);
        Memory.copy(src, dst, 0, dst.length, 1);
    }

    function test_copy_RevertIfCopySourceExceedsSourceLength() public {
        bytes memory src = new bytes(1);
        bytes memory dst = new bytes(1);

        vm.expectRevert(Memory.CopySourceOutOfBounds.selector);
        Memory.copy(src, dst, 0, 0, src.length + 1);
    }

    function test_copy_RevertIfCopyDestinationExceedsDestinationLength() public {
        bytes memory src = new bytes(5);
        bytes memory dst = new bytes(2);

        vm.expectRevert(Memory.CopyDestinationOutOfBounds.selector);
        Memory.copy(src, dst, 0, 0, 5);
    }

    function test_slice() public pure {
        bytes memory src = new bytes(5);
        src[0] = 0x01;
        src[1] = 0x02;
        src[2] = 0x03;
        src[3] = 0x04;
        src[4] = 0x05;

        bytes memory result = Memory.slice(src, 0, 2);
        assertEq(result.length, 2);
        assertEq(uint8(result[0]), 0x01);
        assertEq(uint8(result[1]), 0x02);
    }

    function test_sliceWithOffset() public pure {
        bytes memory src = new bytes(5);
        src[0] = 0x01;
        src[1] = 0x02;
        src[2] = 0x03;
        src[3] = 0x04;
        src[4] = 0x05;

        bytes memory result = Memory.slice(src, 1, 2);
        assertEq(result.length, 2);
        assertEq(uint8(result[0]), 0x02);
        assertEq(uint8(result[1]), 0x03);
    }
}
