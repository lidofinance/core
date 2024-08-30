// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForOracleSanityChecker {
    uint256 private _shareRate = 1 ether;

    function getSharesByPooledEth(uint256 _sharesAmount) external view returns (uint256) {
        return (_shareRate * _sharesAmount) / 1 ether;
    }

    function setShareRate(uint256 _value) external {
        _shareRate = _value;
    }
}
