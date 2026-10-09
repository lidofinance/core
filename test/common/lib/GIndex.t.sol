// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {
    GIndex,
    toGIndex,
    IndexOutOfRange,
    fls,
    ceilLog2,
    staticListNodeGIndex,
    vectorNodeGIndex,
    progressiveListNodeGIndex
} from "contracts/common/lib/GIndex.sol";

// Wrap the library internal methods to make an actual call to them.
// Supposed to be used with `expectRevert` cheatcode.
contract Library {
    function concat(GIndex lhs, GIndex rhs) external pure returns (GIndex) {
        return lhs.concat(rhs);
    }

    function staticListNode(uint256 i, uint256 depth) external pure returns (GIndex) {
        return staticListNodeGIndex(i, depth);
    }

    function vectorNode(uint256 i, uint256 length) external pure returns (GIndex) {
        return vectorNodeGIndex(i, length);
    }

    function progressiveListNode(uint256 i) external pure returns (GIndex) {
        return progressiveListNodeGIndex(i);
    }
}

contract GIndexTest is Test {
    uint256 internal constant LARGEST_PROGRESSIVE_LIST_INDEX = ((4 ** 84 - 1) * 4) / 3;

    GIndex internal ZERO = toGIndex(0);
    GIndex internal ROOT = toGIndex(1);
    GIndex internal MAX = toGIndex(type(uint256).max);

    Library internal lib;

    function setUp() public {
        lib = new Library();
    }

    function test_toGIndex() public {
        assertEq(toGIndex(0).unwrap(), 0);
        assertEq(toGIndex(42).unwrap(), 42);
        assertEq(MAX.unwrap(), type(uint256).max);
    }

    function test_isRootTrue() public {
        assertTrue(ROOT.isRoot(), "ROOT is not root gindex");
    }

    function test_isRootFalse() public {
        assertFalse(toGIndex(0).isRoot(), "Expected toGIndex(0).isRoot() to be false");
        assertFalse(toGIndex(2).isRoot(), "Expected toGIndex(2).isRoot() to be false");
        assertFalse(toGIndex(42).isRoot(), "Expected toGIndex(42).isRoot() to be false");
        assertFalse(toGIndex(2048).isRoot(), "Expected toGIndex(2048).isRoot() to be false");
        assertFalse(MAX.isRoot(), "Expected toGIndex(uint256.max).isRoot() to be false");
    }

    function test_concat() public {
        assertEq(toGIndex(2).concat(toGIndex(3)).unwrap(), 5);
        assertEq(toGIndex(31).concat(toGIndex(3)).unwrap(), 63);
        assertEq(toGIndex(31).concat(toGIndex(6)).unwrap(), 126);
        assertEq(ROOT.concat(toGIndex(2)).concat(toGIndex(5)).concat(toGIndex(9)).unwrap(), 73);

        assertEq(ROOT.concat(MAX).unwrap(), MAX.unwrap());
        assertEq(MAX.concat(ROOT).unwrap(), MAX.unwrap());
    }

    function test_concat_RevertsIfZeroGIndex() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(ZERO, toGIndex(1024));

        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(toGIndex(1024), ZERO);
    }

    function test_concat_BigIndicesBorderCases() public view {
        lib.concat(toGIndex(2 ** 9), toGIndex(2 ** 246));
        lib.concat(toGIndex(2 ** 55), toGIndex(2 ** 200));
        lib.concat(toGIndex(2 ** 199), toGIndex(2 ** 56));
        lib.concat(toGIndex(2 ** 255), ROOT);
    }

    function test_concat_RevertsIfTooBigIndices() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(MAX, MAX);

        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(toGIndex(2 ** 56), toGIndex(2 ** 200));

        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(toGIndex(2 ** 200), toGIndex(2 ** 56));

        vm.expectRevert(IndexOutOfRange.selector);
        lib.concat(toGIndex(2 ** 255), toGIndex(2));
    }

    function testFuzz_concat_WithRoot(GIndex rhs) public {
        vm.assume(rhs.unwrap() > 0);
        assertEq(ROOT.concat(rhs).unwrap(), rhs.unwrap(), "`concat` with a root should return right-hand side value");
        assertEq(rhs.concat(ROOT).unwrap(), rhs.unwrap(), "`concat` of a root should return left-hand side value");
    }

    /// @dev A generalized index is a leading 1 followed by the path bits, so concatenation is
    ///      the left-hand side path followed by the right-hand side path.
    function testFuzz_concat(uint256 lhsPath, uint256 rhsPath, uint8 lhsDepth, uint8 rhsDepth) public {
        uint256 lDepth = lhsDepth;
        uint256 rDepth = uint256(rhsDepth) % (256 - lDepth);
        uint256 lPath = lhsPath & ((1 << lDepth) - 1);
        uint256 rPath = rhsPath & ((1 << rDepth) - 1);

        GIndex lhs = toGIndex((1 << lDepth) | lPath);
        GIndex rhs = toGIndex((1 << rDepth) | rPath);

        uint256 expected = (1 << (lDepth + rDepth)) | (lPath << rDepth) | rPath;
        assertEq(lhs.concat(rhs).unwrap(), expected);
    }

    function testFuzz_concat_IsAssociative(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 1, type(uint64).max);
        b = bound(b, 1, type(uint64).max);
        c = bound(c, 1, type(uint64).max);

        GIndex x = toGIndex(a);
        GIndex y = toGIndex(b);
        GIndex z = toGIndex(c);

        assertEq(x.concat(y).concat(z).unwrap(), x.concat(y.concat(z)).unwrap());
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

    function test_ceilLog2() public {
        assertEq(ceilLog2(0), 0);
        assertEq(ceilLog2(1), 0);
        assertEq(ceilLog2(2), 1);
        assertEq(ceilLog2(3), 2);
        assertEq(ceilLog2(8191), 13);
        assertEq(ceilLog2(8192), 13);
        assertEq(ceilLog2(8193), 14);
        assertEq(ceilLog2(1 << 255), 255);
        assertEq(ceilLog2(type(uint256).max), 256);
    }

    function testFuzz_ceilLog2(uint256 x) public {
        x = bound(x, 1, 1 << 255);

        uint256 p = ceilLog2(x);
        assertGe(1 << p, x);
        if (x > 1) assertLt(1 << (p - 1), x);
    }

    function test_staticListNodeGIndex() public {
        assertEq(staticListNodeGIndex(0, 0).unwrap(), 2);
        assertEq(staticListNodeGIndex(0, 1).unwrap(), 4);
        assertEq(staticListNodeGIndex(1, 1).unwrap(), 5);
        assertEq(staticListNodeGIndex(0, 40).unwrap(), 0x020000000000);
        assertEq(staticListNodeGIndex(12345678, 40).unwrap(), 0x020000bc614e);
        assertEq(staticListNodeGIndex((1 << 40) - 1, 40).unwrap(), 0x02ffffffffff);
    }

    function testFuzz_staticListNodeGIndex(uint256 i, uint256 depth) public {
        depth = bound(depth, 0, 254);
        i = bound(i, 0, (1 << depth) - 1);

        assertEq(staticListNodeGIndex(i, depth).unwrap(), _staticListNodeGIndexReference(i, depth));
        // The data tree of a List[type, 2 ** depth] is a Vector[type, 2 ** depth] hanging off the left branch.
        assertEq(staticListNodeGIndex(i, depth).unwrap(), toGIndex(2).concat(vectorNodeGIndex(i, 1 << depth)).unwrap());
    }

    function test_staticListNodeGIndex_RevertsWhenTooDeep() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.staticListNode(0, 255);

        vm.expectRevert(IndexOutOfRange.selector);
        lib.staticListNode(0, 256);
    }

    function testFuzz_staticListNodeGIndex_RevertsWhenIndexTooLargeForDepth(uint256 i, uint256 depth) public {
        depth = bound(depth, 0, 254);
        i = bound(i, 1 << depth, type(uint256).max);

        vm.expectRevert(IndexOutOfRange.selector);
        lib.staticListNode(i, depth);
    }

    function test_vectorNodeGIndex() public {
        assertEq(vectorNodeGIndex(0, 1).unwrap(), 1);
        assertEq(vectorNodeGIndex(0, 6).unwrap(), 8);
        assertEq(vectorNodeGIndex(5, 6).unwrap(), 13);
        assertEq(vectorNodeGIndex(0, 8192).unwrap(), 8192);
        assertEq(vectorNodeGIndex(4096, 8192).unwrap(), 12288);
        assertEq(vectorNodeGIndex(8191, 8192).unwrap(), 16383);
    }

    function testFuzz_vectorNodeGIndex(uint256 i, uint256 length) public {
        length = bound(length, 1, 1 << 255);
        i = bound(i, 0, length - 1);

        assertEq(vectorNodeGIndex(i, length).unwrap(), _vectorNodeGIndexReference(i, length));
    }

    function test_vectorNodeGIndex_RevertsWhenDepthDoesNotFit() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.vectorNode(0, (1 << 255) + 1);
    }

    function test_vectorNodeGIndex_RevertsWhenLengthIsZero() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.vectorNode(0, 0);
    }

    function testFuzz_vectorNodeGIndex_RevertsWhenIndexIsTooLarge(uint256 i, uint256 length) public {
        length = bound(length, 0, 1 << 255);
        i = bound(i, length, type(uint256).max);

        vm.expectRevert(IndexOutOfRange.selector);
        lib.vectorNode(i, length);
    }

    function test_progressiveListNodeGIndex() public {
        assertEq(progressiveListNodeGIndex(0).unwrap(), 0x4);
        assertEq(progressiveListNodeGIndex(1).unwrap(), 0x28);
        assertEq(progressiveListNodeGIndex(2).unwrap(), 0x29);
        assertEq(progressiveListNodeGIndex(4).unwrap(), 0x2b);
        assertEq(progressiveListNodeGIndex(5).unwrap(), 0x160);
        assertEq(progressiveListNodeGIndex(128).unwrap(), 0x5e2b);
        assertEq(progressiveListNodeGIndex(12345678).unwrap(), 0x5ffe670bf9);
        assertEq(progressiveListNodeGIndex((1 << 40) - 1).unwrap(), 0x5ffffeaaaaaaaaaa);
        assertEq(
            progressiveListNodeGIndex(LARGEST_PROGRESSIVE_LIST_INDEX).unwrap(),
            0x5ffffffffffffffffffffeffffffffffffffffffffffffffffffffffffffffff
        );
    }

    function testFuzz_progressiveListNodeGIndex(uint256 i) public {
        i = bound(i, 0, LARGEST_PROGRESSIVE_LIST_INDEX);

        assertEq(progressiveListNodeGIndex(i).unwrap(), _progressiveListNodeGIndexReference(i));
    }

    function test_progressiveListNodeGIndex_RevertsWhenIndexTooLarge() public {
        vm.expectRevert(IndexOutOfRange.selector);
        lib.progressiveListNode(LARGEST_PROGRESSIVE_LIST_INDEX + 1);

        vm.expectRevert(IndexOutOfRange.selector);
        lib.progressiveListNode(type(uint256).max / 3);

        vm.expectRevert(IndexOutOfRange.selector);
        lib.progressiveListNode(type(uint256).max);
    }

    /// @dev Walks down from the list root: one step left to the data tree, then `depth` steps
    ///      following the bits of `i` from the most significant one.
    function _staticListNodeGIndexReference(uint256 i, uint256 depth) private pure returns (uint256 gI) {
        gI = 2;
        for (uint256 level = depth; level > 0; --level) {
            gI = (gI << 1) | ((i >> (level - 1)) & 1);
        }
    }

    function _vectorNodeGIndexReference(uint256 i, uint256 length) private pure returns (uint256) {
        uint256 depth;
        while ((1 << depth) < length) ++depth;
        return (1 << depth) + i;
    }

    function _progressiveListNodeGIndexReference(uint256 i) private pure returns (uint256) {
        uint256 depth;
        uint256 gI = 2;

        while (true) {
            uint256 chunkSize = 1 << depth;
            if (i < chunkSize) {
                return ((gI << 1) << depth) + i;
            }

            i -= chunkSize;
            depth += 2;
            gI = (gI << 1) + 1;
        }

        return 0;
    }
}
