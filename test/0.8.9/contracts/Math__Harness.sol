// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {Math} from "contracts/0.8.9/lib/Math.sol";

contract Math__Harness {
    function max(uint256 a, uint256 b) public pure returns (uint256) {
        return Math.max(a, b);
    }

    function min(uint256 a, uint256 b) public pure returns (uint256) {
        return Math.min(a, b);
    }

    function pointInHalfOpenIntervalModN(uint256 x, uint256 a, uint256 b, uint256 n) public pure returns (bool) {
        return Math.pointInHalfOpenIntervalModN(x, a, b, n);
    }

    function pointInClosedIntervalModN(uint256 x, uint256 a, uint256 b, uint256 n) public pure returns (bool) {
        return Math.pointInClosedIntervalModN(x, a, b, n);
    }
}
