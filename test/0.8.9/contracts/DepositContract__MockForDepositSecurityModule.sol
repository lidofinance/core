// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract DepositContract__MockForDepositSecurityModule {
    bytes32 internal depositRoot;

    function get_deposit_root() external view returns (bytes32) {
        return depositRoot;
    }

    function set_deposit_root(bytes32 _newRoot) external {
        depositRoot = _newRoot;
    }
}
