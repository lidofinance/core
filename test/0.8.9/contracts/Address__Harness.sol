// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {Address} from "contracts/0.8.9/proxy/WithdrawalsManagerProxy.sol";

contract Address__Harness {
    function isContract(address account) external view returns (bool) {
        return Address.isContract(account);
    }

    function sendValue(address payable recipient, uint256 amount) external payable {
        Address.sendValue(recipient, amount);
    }

    function functionCall(address target, bytes memory data) external returns (bytes memory) {
        return Address.functionCall(target, data);
    }

    function functionCall(
        address target,
        bytes memory data,
        string memory errorMessage
    ) external returns (bytes memory) {
        return Address.functionCall(target, data, errorMessage);
    }

    function functionCallWithValue(
        address target,
        bytes memory data,
        uint256 value
    ) external payable returns (bytes memory) {
        return Address.functionCallWithValue(target, data, value);
    }

    function functionCallWithValue(
        address target,
        bytes memory data,
        uint256 value,
        string memory errorMessage
    ) external payable returns (bytes memory) {
        return Address.functionCallWithValue(target, data, value, errorMessage);
    }

    function functionStaticCall(address target, bytes memory data) external view returns (bytes memory) {
        return Address.functionStaticCall(target, data);
    }

    function functionStaticCall(
        address target,
        bytes memory data,
        string memory errorMessage
    ) external view returns (bytes memory) {
        return Address.functionStaticCall(target, data, errorMessage);
    }

    function functionDelegateCall(address target, bytes memory data) external returns (bytes memory) {
        return Address.functionDelegateCall(target, data);
    }

    function functionDelegateCall(
        address target,
        bytes memory data,
        string memory errorMessage
    ) external returns (bytes memory) {
        return Address.functionDelegateCall(target, data, errorMessage);
    }
}
