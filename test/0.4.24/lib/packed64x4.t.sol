// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.4.24;

import {Packed64x4} from "contracts/0.4.24/lib/Packed64x4.sol";

contract Packed64x4Test {
    using Packed64x4 for Packed64x4.Packed;

    function test_set() public {
        Packed64x4.Packed memory packed = Packed64x4.Packed(0);

        packed.set(0, 1);
        assert(packed.get(0) == 1);

        packed.set(1, 2);
        assert(packed.get(1) == 2);

        packed.set(2, 3);
        assert(packed.get(2) == 3);

        packed.set(3, 4);
        assert(packed.get(3) == 4);

        // packed.set(4, 5); // FIXME: This should revert
        assert(packed.get(0) == 1);
    }
}
