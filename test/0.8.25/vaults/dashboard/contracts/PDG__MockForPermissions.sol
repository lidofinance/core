// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract PDG__MockForPermissions {
    event MockCompensateDisprovenPredeposit(address indexed sender, bytes pubkey, address indexed recipient);

    function compensateDisprovenPredeposit(bytes calldata _pubkey, address _recipient) external returns (uint256) {
        emit MockCompensateDisprovenPredeposit(msg.sender, _pubkey, _recipient);
        return 1 ether;
    }
}
