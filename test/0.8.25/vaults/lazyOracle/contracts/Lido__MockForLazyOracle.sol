// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

contract Lido__MockForLazyOracle {
    constructor() {}

    function getPooledEthBySharesRoundUp(uint256 value) external pure returns (uint256) {
        return value;
    }

    function getSharesByPooledEth(uint256 value) external pure returns (uint256) {
        return value;
    }
}
