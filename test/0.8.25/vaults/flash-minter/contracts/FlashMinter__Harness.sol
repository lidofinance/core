// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {FlashMinter} from "contracts/0.8.25/vaults/FlashMinter.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";

contract FlashMinter__Harness is FlashMinter {
    constructor(ILido _stETH) FlashMinter(_stETH) {}

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __VaultHub_init(_admin);
    }
}
