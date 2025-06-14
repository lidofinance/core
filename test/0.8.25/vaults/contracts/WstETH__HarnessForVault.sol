// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.6.12;

import {WstETH} from "contracts/0.6.12/WstETH.sol";
import {IStETH} from "contracts/0.6.12/interfaces/IStETH.sol";

contract WstETH__HarnessForVault is WstETH {
    constructor(IStETH _StETH) public WstETH(_StETH) {}

    function harness__mint(address recipient, uint256 amount) public {
        _mint(recipient, amount);
    }

    function harness__burn(address account, uint256 amount) public {
        _burn(account, amount);
    }
}
