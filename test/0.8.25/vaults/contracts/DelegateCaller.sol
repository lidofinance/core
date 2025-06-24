// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract DelegateCaller {
    function callDelegate(address target, bytes memory data) external payable returns (bytes memory) {
        (bool success, bytes memory result) = target.delegatecall(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}
