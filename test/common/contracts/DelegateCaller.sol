// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract DelegateCaller {
    function callDelegate(address target, bytes memory data) external payable returns (bytes memory) {
        (bool success, bytes memory result) = target.delegatecall(data);
        require(success, "Delegatecall failed");
        return result;
    }
}
