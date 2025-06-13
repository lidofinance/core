// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {GIndex, pack, IndexOutOfRange, fls} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";

// Wrap the library internal methods to make an actual call to them.
// Supposed to be used with `expectRevert` cheatcode.
contract Library {
    function concat(GIndex lhs, GIndex rhs) public pure returns (GIndex) {
        return lhs.concat(rhs);
    }

    function shr(GIndex self, uint256 n) public pure returns (GIndex) {
        return self.shr(n);
    }

    function shl(GIndex self, uint256 n) public pure returns (GIndex) {
        return self.shl(n);
    }
}

contract GIndexTest is Test {
    GIndex internal ZERO = GIndex.wrap(bytes32(0));
    GIndex internal ROOT = GIndex.wrap(0x0000000000000000000000000000000000000000000000000000000000000100);
    GIndex internal MAX = GIndex.wrap(bytes32(type(uint256).max));

    Library internal lib;

    error Log2Undefined();

    function setUp() public {
        lib = new Library();
    }

    function test_pack() public {
        GIndex gI;

        gI = pack(0x7b426f79504c6a8e9d31415b722f696e705c8a3d9f41, 42);
        assertEq(
            gI.unwrap(),
            0x0000000000000000007b426f79504c6a8e9d31415b722f696e705c8a3d9f412a,
            "Invalid gindex encoded"
        );

        assertEq(MAX.unwrap(), bytes32(type(uint256).max), "Invalid gindex encoded");
    }

    function test_isRootTrue() public {
        assertTrue(ROOT.isRoot(), "ROOT is not root gindex");
    }

    function test_isRootFalse() public {
        GIndex gI;

        gI = pack(0, 0);
        assertFalse(gI.isRoot(), "Expected [0,0].isRoot() to be false");

        gI = pack(42, 0);
        assertFalse(gI.isRoot(), "Expected [42,0].isRoot() to be false");

        gI = pack(42, 4);
        assertFalse(gI.isRoot(), "Expected [42,4].isRoot() to be false");

        gI = pack(2048, 4);
        assertFalse(gI.isRoot(), "Expected [2048,4].isRoot() to be false");

        gI = pack(type(uint248).max, type(uint8).max);
        assertFalse(gI.isRoot(), "Expected [uint248.max,uint8.max].isRoot() to be false");
    }

    function test_isParentOf_Truthy() public {
        assertTrue(pack(1024, 0).isParentOf(pack(2048, 0)));
        assertTrue(pack(1024, 0).isParentOf(pack(2049, 0)));
        assertTrue(pack(1024, 9).isParentOf(pack(2048, 0)));
        assertTrue(pack(1024, 9).isParentOf(pack(2049, 0)));
        assertTrue(pack(1024, 0).isParentOf(pack(2048, 9)));
        assertTrue(pack(1024, 0).isParentOf(pack(2049, 9)));
        assertTrue(pack(1023, 0).isParentOf(pack(4094, 0)));
        assertTrue(pack(1024, 0).isParentOf(pack(4098, 0)));
    }

    function testFuzz_ROOT_isParentOfAnyChild(GIndex rhs) public {
        vm.assume(rhs.index() > 1);
        assertTrue(ROOT.isParentOf(rhs));
    }

    function testFuzz_isParentOf_LessThanAnchor(GIndex lhs, GIndex rhs) public {
        vm.assume(rhs.index() < lhs.index());
        assertFalse(lhs.isParentOf(rhs));
    }

    function test_isParentOf_OffTheBranch() public {
        assertFalse(pack(1024, 0).isParentOf(pack(2050, 0)));
        assertFalse(pack(1024, 0).isParentOf(pack(2051, 0)));
        assertFalse(pack(1024, 0).isParentOf(pack(2047, 0)));
        assertFalse(pack(1024, 0).isParentOf(pack(2046, 0)));
        assertFalse(pack(1024, 9).isParentOf(pack(2050, 0)));
        assertFalse(pack(1024, 9).isParentOf(pack(2051, 0)));
        assertFalse(pack(1024, 9).isParentOf(pack(2047, 0)));
        assertFalse(pack(1024, 9).isParentOf(pack(2046, 0)));
        assertFalse(pack(1024, 0).isParentOf(pack(2050, 9)));
        assertFalse(pack(1024, 0).isParentOf(pack(2051, 9)));
        assertFalse(pack(1024, 0).isParentOf(pack(2047, 9)));
        assertFalse(pack(1024, 0).isParentOf(pack(2046, 9)));
        assertFalse(pack(1023, 0).isParentOf(pack(2048, 0)));
        assertFalse(pack(1023, 0).isParentOf(pack(2049, 0)));
        assertFalse(pack(1023, 9).isParentOf(pack(2048, 0)));
        assertFalse(pack(1023, 9).isParentOf(pack(2049, 0)));
        assertFalse(pack(1023, 0).isParentOf(pack(4098, 0)));
        assertFalse(pack(1024, 0).isParentOf(pack(4094, 0)));
    }

    function test_concat() public {
        assertEq(pack(2, 99).concat(pack(3, 99)).unwrap(), pack(5, 99).unwrap());
        assertEq(pack(31, 99).concat(pack(3, 99)).unwrap(), pack(63, 99).unwrap());
        assertEq(pack(31, 99).concat(pack(6, 99)).unwrap(), pack(126, 99).unwrap());
        assertEq(ROOT.concat(pack(2, 1)).concat(pack(5, 1)).concat(pack(9, 1)).unwrap(), pack(73, 1).unwrap());
        assertEq(ROOT.concat(pack(2, 9)).concat(pack(5, 1)).concat(pack(9, 4)).unwrap(), pack(73, 4).unwrap());

        assertEq(ROOT.concat(MAX).unwrap(), MAX.unwrap());
    }

    function test_concat_RevertsIfZeroGIndex() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(ZERO, pack(1024, 1));

        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(pack(1024, 1), ZERO);
    }

    function test_concat_BigIndicesBorderCases() public view {
        lib.concat(pack(2 ** 9, 0), pack(2 ** 238, 0));
        lib.concat(pack(2 ** 47, 0), pack(2 ** 200, 0));
        lib.concat(pack(2 ** 199, 0), pack(2 ** 48, 0));
    }

    function test_concat_RevertsIfTooBigIndices() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(MAX, MAX);

        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(pack(2 ** 48, 0), pack(2 ** 200, 0));

        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(pack(2 ** 200, 0), pack(2 ** 48, 0));
    }

    function testFuzz_concat_WithRoot(GIndex rhs) public {
        vm.assume(rhs.index() > 0);
        assertEq(ROOT.concat(rhs).unwrap(), rhs.unwrap(), "`concat` with a root should return right-hand side value");
    }

    function testFuzz_concat_isParentOf(GIndex lhs, GIndex rhs) public {
        // Left-hand side value can be a root.
        vm.assume(lhs.index() > 0);
        // But root.concat(root) will result in a root value again, and root is not a parent for itself.
        vm.assume(rhs.index() > 1);
        // Overflow check.
        vm.assume(fls(lhs.index()) + 1 + fls(rhs.index()) < 248);

        assertTrue(lhs.isParentOf(lhs.concat(rhs)), "Left-hand side value should be a parent of `concat` result");
        assertFalse(lhs.concat(rhs).isParentOf(lhs), "`concat` result can't be a parent for the left-hand side value");
        assertFalse(lhs.concat(rhs).isParentOf(rhs), "`concat` result can't be a parent for the right-hand side value");
    }

    function testFuzz_unpack(uint248 index, uint8 pow) public {
        GIndex gI = pack(index, pow);
        assertEq(gI.index(), index);
        assertEq(gI.width(), 2 ** pow);
    }

    function test_shr() public {
        GIndex gI;

        gI = pack(1024, 4);
        assertEq(gI.shr(0).unwrap(), pack(1024, 4).unwrap());
        assertEq(gI.shr(1).unwrap(), pack(1025, 4).unwrap());
        assertEq(gI.shr(15).unwrap(), pack(1039, 4).unwrap());

        gI = pack(1031, 4);
        assertEq(gI.shr(0).unwrap(), pack(1031, 4).unwrap());
        assertEq(gI.shr(1).unwrap(), pack(1032, 4).unwrap());
        assertEq(gI.shr(8).unwrap(), pack(1039, 4).unwrap());

        gI = pack(2049, 4);
        assertEq(gI.shr(0).unwrap(), pack(2049, 4).unwrap());
        assertEq(gI.shr(1).unwrap(), pack(2050, 4).unwrap());
        assertEq(gI.shr(14).unwrap(), pack(2063, 4).unwrap());
    }

    function test_shr_AfterConcat() public {
        GIndex gI;
        GIndex gIParent = pack(5, 4);

        gI = pack(1024, 4);
        assertEq(gIParent.concat(gI).shr(0).unwrap(), pack(5120, 4).unwrap());
        assertEq(gIParent.concat(gI).shr(1).unwrap(), pack(5121, 4).unwrap());
        assertEq(gIParent.concat(gI).shr(15).unwrap(), pack(5135, 4).unwrap());

        gI = pack(1031, 4);
        assertEq(gIParent.concat(gI).shr(0).unwrap(), pack(5127, 4).unwrap());
        assertEq(gIParent.concat(gI).shr(1).unwrap(), pack(5128, 4).unwrap());
        assertEq(gIParent.concat(gI).shr(8).unwrap(), pack(5135, 4).unwrap());

        gI = pack(2049, 4);
        assertEq(gIParent.concat(gI).shr(0).unwrap(), pack(10241, 4).unwrap());
        assertEq(gIParent.concat(gI).shr(1).unwrap(), pack(10242, 4).unwrap());
        assertEq(gIParent.concat(gI).shr(14).unwrap(), pack(10255, 4).unwrap());
    }

    function test_shr_OffTheWidth() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(ROOT, 1);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(pack(1024, 4), 16);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(pack(1031, 4), 9);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(pack(1023, 4), 1);
    }

    function test_shr_OffTheWidth_AfterConcat() public {
        GIndex gIParent = pack(154, 4);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(gIParent.concat(ROOT), 1);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(gIParent.concat(pack(1024, 4)), 16);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(gIParent.concat(pack(1031, 4)), 9);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(gIParent.concat(pack(1023, 4)), 1);
    }

    function testFuzz_shr_OffTheWidth_AfterConcat(GIndex lhs, GIndex rhs, uint256 shift) public {
        // Indices concatenation overflow protection.
        vm.assume(fls(lhs.index()) + 1 + fls(rhs.index()) < 248);
        vm.assume(rhs.index() >= rhs.width());
        unchecked {
            vm.assume(rhs.width() + shift > rhs.width());
            vm.assume(lhs.concat(rhs).index() + shift > lhs.concat(rhs).index());
        }

        vm.expectRevert(IndexOutOfRange.selector);
        lib.shr(lhs.concat(rhs), rhs.width() + shift);
    }

    function test_shl() public {
        GIndex gI;

        gI = pack(1023, 4);
        assertEq(gI.shl(0).unwrap(), pack(1023, 4).unwrap());
        assertEq(gI.shl(1).unwrap(), pack(1022, 4).unwrap());
        assertEq(gI.shl(15).unwrap(), pack(1008, 4).unwrap());

        gI = pack(1031, 4);
        assertEq(gI.shl(0).unwrap(), pack(1031, 4).unwrap());
        assertEq(gI.shl(1).unwrap(), pack(1030, 4).unwrap());
        assertEq(gI.shl(7).unwrap(), pack(1024, 4).unwrap());

        gI = pack(2063, 4);
        assertEq(gI.shl(0).unwrap(), pack(2063, 4).unwrap());
        assertEq(gI.shl(1).unwrap(), pack(2062, 4).unwrap());
        assertEq(gI.shl(15).unwrap(), pack(2048, 4).unwrap());
    }

    function test_shl_AfterConcat() public {
        GIndex gI;
        GIndex gIParent = pack(5, 4);

        gI = pack(1023, 4);
        assertEq(gIParent.concat(gI).shl(0).unwrap(), pack(3071, 4).unwrap());
        assertEq(gIParent.concat(gI).shl(1).unwrap(), pack(3070, 4).unwrap());
        assertEq(gIParent.concat(gI).shl(15).unwrap(), pack(3056, 4).unwrap());

        gI = pack(1031, 4);
        assertEq(gIParent.concat(gI).shl(0).unwrap(), pack(5127, 4).unwrap());
        assertEq(gIParent.concat(gI).shl(1).unwrap(), pack(5126, 4).unwrap());
        assertEq(gIParent.concat(gI).shl(7).unwrap(), pack(5120, 4).unwrap());

        gI = pack(2063, 4);
        assertEq(gIParent.concat(gI).shl(0).unwrap(), pack(10255, 4).unwrap());
        assertEq(gIParent.concat(gI).shl(1).unwrap(), pack(10254, 4).unwrap());
        assertEq(gIParent.concat(gI).shl(15).unwrap(), pack(10240, 4).unwrap());
    }

    function test_shl_OffTheWidth() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(ROOT, 1);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(pack(1024, 4), 1);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(pack(1031, 4), 9);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(pack(1023, 4), 16);
    }

    function test_shl_OffTheWidth_AfterConcat() public {
        GIndex gIParent = pack(154, 4);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(gIParent.concat(ROOT), 1);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(gIParent.concat(pack(1024, 4)), 1);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(gIParent.concat(pack(1031, 4)), 9);
        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(gIParent.concat(pack(1023, 4)), 16);
    }

    function testFuzz_shl_OffTheWidth_AfterConcat(GIndex lhs, GIndex rhs, uint256 shift) public {
        // Indices concatenation overflow protection.
        vm.assume(fls(lhs.index()) + 1 + fls(rhs.index()) < 248);
        vm.assume(rhs.index() >= rhs.width());
        vm.assume(shift > rhs.index() % rhs.width());

        vm.expectRevert(IndexOutOfRange.selector);
        lib.shl(lhs.concat(rhs), shift);
    }

    function testFuzz_shl_shr_Idempotent(GIndex gI, uint256 shift) public {
        vm.assume(gI.index() > 0);
        vm.assume(gI.index() >= gI.width());
        vm.assume(shift < gI.index() % gI.width());

        assertEq(lib.shr(lib.shl(gI, shift), shift).unwrap(), gI.unwrap());
    }

    function testFuzz_shr_shl_Idempotent(GIndex gI, uint256 shift) public {
        vm.assume(gI.index() > 0);
        vm.assume(gI.index() >= gI.width());
        vm.assume(shift < gI.width() - (gI.index() % gI.width()));

        assertEq(lib.shl(lib.shr(gI, shift), shift).unwrap(), gI.unwrap());
    }

    function test_fls() public {
        for (uint256 i = 1; i < 255; i++) {
            assertEq(fls((1 << i) - 1), i - 1);
            assertEq(fls((1 << i)), i);
            assertEq(fls((1 << i) + 1), i);
        }

        assertEq(fls(3), 1); // 0011
        assertEq(fls(7), 2); // 0101
        assertEq(fls(10), 3); // 1010
        assertEq(fls(300), 8); // 0001 0010 1100
        assertEq(fls(0), 256);
    }
}
