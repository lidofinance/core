// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import "forge-std/Test.sol";

import {Math256} from "contracts/common/lib/Math256.sol";

contract Math256CcwDistanceTest is Test {
    function test_ccwDistance32_WorksWithOverflow() public pure {
        uint32 a = 0;
        uint32 b = type(uint32).max;

        assertEq(Math256.ccwDistance32(a, b), 1);
        assertEq(Math256.ccwDistance32(b, a), type(uint32).max);
    }

    function test_ccwDistance32_WorksWithOverflow2() public pure {
        uint32 a = 1;
        uint32 b = type(uint32).max - 1;

        assertEq(Math256.ccwDistance32(a, b), 3);
        assertEq(Math256.ccwDistance32(b, a), type(uint32).max - 2);
    }

    function test_ccwDistance32_WorksWithoutOverflow() public pure {
        uint32 a = 1;
        uint32 b = 0;

        assertEq(Math256.ccwDistance32(a, b), 1);
        assertEq(Math256.ccwDistance32(b, a), type(uint32).max);
    }

    function test_ccwDistance32_WorksWithBothEqual() public pure {
        uint32 a = 1;
        uint32 b = 1;

        assertEq(Math256.ccwDistance32(a, b), 0);
        assertEq(Math256.ccwDistance32(b, a), 0);
    }

    function test_ccwDistance32_WorksWithBothMax() public pure {
        uint32 a = type(uint32).max;
        uint32 b = type(uint32).max;

        assertEq(Math256.ccwDistance32(a, b), 0);
        assertEq(Math256.ccwDistance32(b, a), 0);
    }

    function test_ccwDistance32_WorksWithBothMin() public pure {
        uint32 a = 0;
        uint32 b = 0;

        assertEq(Math256.ccwDistance32(a, b), 0);
        assertEq(Math256.ccwDistance32(b, a), 0);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_ccwDistance32_WorksWithUint32(uint32 a, uint32 b) public pure {
        uint256 direct = Math256.ccwDistance32(a, b);
        uint256 reverse = Math256.ccwDistance32(b, a);

        uint256 modulo = uint256(type(uint32).max) + 1;

        if (a != b) {
            assertEq(direct + reverse, modulo, "direct + reverse (a != b)");
        } else {
            assertEq(direct + reverse, 0, "direct + reverse (a = b)");
        }

        if (a > b) {
            assertEq(direct, a - b);
            assertEq(reverse, modulo - (a - b));
        } else if (b > a) {
            assertEq(reverse, b - a);
            assertEq(direct, modulo - (b - a));
        }
    }
}
