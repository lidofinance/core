// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

contract OperatorGrid__MockForLazyOracle {
    constructor() {}

    function effectiveShareLimit(address) external pure returns (uint256) {
        return 1000000000000000000;
    }
}
