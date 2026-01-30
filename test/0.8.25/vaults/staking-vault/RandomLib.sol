// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-v5.2/utils/math/Math.sol";

library RandomLib {
    using Math for uint256;

    uint256 private constant Q96 = 2 ** 96;
    uint256 private constant D18 = 1e18;

    struct Storage {
        uint256 seed;
    }

    function rand(Storage storage s) internal returns (uint256) {
        s.seed = uint256(keccak256(abi.encodePacked(block.timestamp, block.prevrandao, s.seed)));
        return s.seed;
    }

    function randInt(Storage storage s, uint256 maxValue) internal returns (uint256) {
        return rand(s) % (maxValue + 1);
    }

    function randInt(Storage storage s, uint256 minValue, uint256 maxValue) internal returns (uint256) {
        if (maxValue < minValue) {
            revert("RandomLib: maxValue < minValue");
        }
        return (rand(s) % (maxValue - minValue + 1)) + minValue;
    }

    function randFloatX96(Storage storage s, uint256 minValue, uint256 maxValue) internal returns (uint256) {
        return randInt(s, minValue * Q96, maxValue * Q96);
    }

    function randBool(Storage storage s) internal returns (bool) {
        return rand(s) & 1 == 1;
    }

    function randAddress(Storage storage s) internal returns (address) {
        return address(uint160(rand(s)));
    }

    function randAmountD18(Storage storage s) internal returns (uint256 result) {
        uint256 result_x96 = randFloatX96(s, D18, 10 * D18);
        if (randBool(s)) {
            uint256 b_x96 = randFloatX96(s, 1, 1e6);
            result = result_x96.mulDiv(b_x96, Q96) / Q96;
        } else {
            uint256 b_x96 = randFloatX96(s, 1e1, 1e10);
            result = result_x96.mulDiv(Q96, b_x96) / Q96;
        }
    }
}
