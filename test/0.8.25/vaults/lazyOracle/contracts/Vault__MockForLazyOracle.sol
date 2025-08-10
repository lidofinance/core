// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

contract Vault__MockForLazyOracle {
    constructor() {}

    function withdrawalCredentials() external pure returns (bytes32) {
        return bytes32(0);
    }
}
