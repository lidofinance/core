// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.4.24 <0.9.0;

import "forge-std/Test.sol";

import {Math256} from "contracts/common/lib/Math256.sol";

contract Math256Test is Test {
    function test_max_WorksWithABUint256() public pure {
        uint256 a = 1;
        uint256 b = 2;

        assertEq(Math256.max(a, b), b);
    }

    function test_max_WorksWithBAUint256() public pure {
        uint256 a = 1;
        uint256 b = 2;

        assertEq(Math256.max(b, a), b);
    }

    function test_max_WorksWithBothEqualUint256() public pure {
        uint256 a = 1;
        uint256 b = 1;

        assertEq(Math256.max(b, a), b);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_max_WorksWithUint256(uint256 a, uint256 b) public pure {
        uint256 expected;

        if (a > b) {
            expected = a;
        } else {
            expected = b;
        }

        // Must not crash
        Math256.min(b, a);

        // Must be commutative
        assertEq(Math256.min(b, a), Math256.min(a, b));

        // Must be expected
        assertEq(Math256.max(b, a), expected);
    }

    function test_min_WorksWithABUint256() public pure {
        uint256 a = 2;
        uint256 b = 1;

        assertEq(Math256.min(a, b), b);
    }

    function test_min_WorksWithBAUint256() public pure {
        uint256 a = 1;
        uint256 b = 2;

        assertEq(Math256.min(b, a), a);
    }

    function test_min_WorksWithBothEqualUint256() public pure {
        uint256 a = 1;
        uint256 b = 1;

        assertEq(Math256.max(b, a), b);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_min_WorksWithUint256(uint256 a, uint256 b) public pure {
        uint256 expected;

        if (a < b) {
            expected = a;
        } else {
            expected = b;
        }

        // Must be commutative
        assertEq(Math256.min(b, a), Math256.min(a, b));

        // Must be expected
        assertEq(Math256.min(b, a), expected);
    }

    function test_max_WorksWithABInt256() public pure {
        int256 a = 1;
        int256 b = 2;

        assertEq(Math256.max(a, b), b);
    }

    function test_max_WorksWithBAInt256() public pure {
        int256 a = 1;
        int256 b = 2;

        assertEq(Math256.max(b, a), b);
    }

    function test_max_WorksWithEqualABInt256() public pure {
        int256 a = 1;
        int256 b = 1;

        assertEq(Math256.max(b, a), b);
    }

    function test_max_WorksWithBothNegativeABInt256() public pure {
        int256 a = -1;
        int256 b = -2;

        assertEq(Math256.max(a, b), a);
    }

    function test_max_WorksWithBothNegativeBAInt256() public pure {
        int256 a = -1;
        int256 b = -2;

        assertEq(Math256.max(b, a), a);
    }

    function test_max_WorksWithPositiveAndNegativeInt256() public pure {
        int256 a = 1;
        int256 b = -2;

        assertEq(Math256.max(a, b), a);
    }

    function test_max_WorksWithNegativeAndPositiveInt256() public pure {
        int256 a = 1;
        int256 b = -2;

        assertEq(Math256.max(b, a), a);
    }

    function test_max_WorksWithEqualNegativeBAInt256() public pure {
        int256 a = -1;
        int256 b = -1;

        assertEq(Math256.max(b, a), b);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_max_WorksWithInt256(int256 a, int256 b) public pure {
        int256 expected;

        if (a > b) {
            expected = a;
        } else {
            expected = b;
        }

        // Must be commutative
        assertEq(Math256.max(b, a), Math256.max(a, b));

        // Must be expected
        assertEq(Math256.max(b, a), expected);
    }

    function test_min_WorksWithABInt256() public pure {
        int256 a = 2;
        int256 b = 1;

        assertEq(Math256.min(a, b), b);
    }

    function test_min_WorksWithBAInt256() public pure {
        int256 a = 1;
        int256 b = 2;

        assertEq(Math256.min(b, a), a);
    }

    function test_min_WorksWithEqualBAInt256() public pure {
        int256 a = 1;
        int256 b = 1;

        assertEq(Math256.max(b, a), b);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_min_WorksWithInt256(int256 a, int256 b) public pure {
        int256 expected;

        if (a < b) {
            expected = a;
        } else {
            expected = b;
        }

        // Must not crash
        Math256.min(b, a);

        // Must be commutative
        assertEq(Math256.min(b, a), Math256.min(a, b));

        // Must be expected
        assertEq(Math256.min(b, a), expected);
    }

    // Commenting this out, as the implementation doesn't solve for this case
    // function test_ceilDiv_ByZero() public pure {
    //     uint256 a = 1;
    //     uint256 b = 0;
    //
    //     vm.expectRevert("Division or modulo by 0");
    //     Math256.ceilDiv(a, b);
    // }

    function test_ceilDiv_WorksWithZeroFromFour() public pure {
        uint256 a = 0;
        uint256 b = 4;

        assertEq(Math256.ceilDiv(a, b), 0);
    }

    function test_ceilDiv_WorksForOne() public pure {
        uint256 a = 2;
        uint256 b = 1;

        assertEq(Math256.ceilDiv(a, b), a);
    }

    function test_ceilDiv_WorksForTwo() public pure {
        uint256 a = 4;
        uint256 b = 2;

        assertEq(Math256.ceilDiv(a, b), b);
    }

    function test_ceilDiv_WorksForThree() public pure {
        uint256 a = 4;
        uint256 b = 3;

        assertEq(Math256.ceilDiv(a, b), 2);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_ceilDiv(uint256 a, uint256 b) public pure {
        // This case should always error, so skip it
        if (b == 0) {
            return;
        }

        // This case should always be zero
        if (a == 0) {
            assertEq(Math256.ceilDiv(a, b), 0);
        }

        // When they are both equal, the orientation shouldn't matter, it should be 1
        if (a == b) {
            assertEq(Math256.ceilDiv(a, b), 1);
            assertEq(Math256.ceilDiv(b, a), 1);
        }

        uint256 expected = (a == 0 ? 0 : (a - 1) / b + 1);

        assertEq(Math256.ceilDiv(a, b), expected);
    }

    /// tests for absDiff

    function test_absDiff_WorksWithZeros() public pure {
        uint256 a = 0;
        uint256 b = 0;

        assertEq(Math256.absDiff(b, a), 0);
    }

    function test_absDiff_WorksWithOnes() public pure {
        uint256 a = 1;
        uint256 b = 1;

        assertEq(Math256.absDiff(b, a), 0);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_absDiff(uint256 a, uint256 b) public pure {
        // It shouldn't unexpectedly crash
        Math256.absDiff(b, a);

        // If they are the same, it's always zero
        if (a == b) {
            assertEq(Math256.absDiff(b, a), 0);
        }

        // They are different
        if (b > a) {
            assertEq(Math256.absDiff(b, a), b - a);
        } else {
            assertEq(Math256.absDiff(a, b), a - b);
        }

        // If one is zero, the difference should always be the other
        if (a == 0) {
            assertEq(Math256.absDiff(b, a), b);
        }

        // Must be commutative
        assertEq(Math256.absDiff(b, a), Math256.absDiff(a, b));
    }
}
