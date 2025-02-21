// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Sideloading} from "contracts/0.8.25/vaults/Sideloading.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";

contract Sideloading__Harness is Sideloading {
    constructor(ILido _stETH) Sideloading(_stETH) {}

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __VaultHub_init(_admin);
    }
}
