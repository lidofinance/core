// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {Proxy} from "contracts/0.8.9/proxy/WithdrawalsManagerProxy.sol";

contract Proxy__Harness is Proxy {
    address private impl;

    function setImplementation(address newImpl) external {
        impl = newImpl;
    }

    function implementation() external view returns (address) {
        return _implementation();
    }

    function _implementation() internal view override returns (address) {
        return impl;
    }
}
