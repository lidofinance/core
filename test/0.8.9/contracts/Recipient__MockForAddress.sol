// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Recipient__MockForAddress {
    bool private receiveShouldRevert;

    function mock__receive(bool shouldRevert) external {
        receiveShouldRevert = shouldRevert;
    }

    receive() external payable {
        require(!receiveShouldRevert);
    }

    uint256 public number;

    function increment() external payable {
        number++;
    }

    function revertsWithMessage() external view {
        revert("Reverted");
    }

    function staticFunction() external pure returns (string memory) {
        return "0x1234";
    }

    function writeToStorage(bytes32 slot, bytes32 value) external {
        assembly {
            sstore(slot, value)
        }
    }

    function revertingFunction() external {
        revert();
    }
}
