// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.4.24 <0.9.0;

interface ITimeProvider {
    function getTime() external view returns (uint256);
}
