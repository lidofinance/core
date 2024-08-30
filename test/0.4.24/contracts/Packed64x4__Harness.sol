// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.4.24;

import {Packed64x4} from "contracts/0.4.24/lib/Packed64x4.sol";

contract Packed64x4__Harness {
    using Packed64x4 for Packed64x4.Packed;

    Packed64x4.Packed public packed = Packed64x4.Packed(0);

    function get(uint8 n) public view returns (uint256 r) {
        return packed.get(n);
    }

    function set(uint8 n, uint256 x) public {
        Packed64x4.Packed memory temp = packed;
        temp.set(n, x);
        packed = temp;
    }

    function add(uint8 n, uint256 x) public {
        Packed64x4.Packed memory temp = packed;
        temp.add(n, x);
        packed = temp;
    }

    function sub(uint8 n, uint256 x) public {
        Packed64x4.Packed memory temp = packed;
        temp.sub(n, x);
        packed = temp;
    }
}
