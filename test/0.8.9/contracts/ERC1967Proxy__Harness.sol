// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {ERC1967Proxy} from "contracts/0.8.9/proxy/WithdrawalsManagerProxy.sol";

contract ERC1967Proxy__Harness is ERC1967Proxy {
    constructor(address _logic, bytes memory _data) payable ERC1967Proxy(_logic, _data) {}

    function implementation() external view returns (address) {
        return _implementation();
    }
}
