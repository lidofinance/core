// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {ERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/ERC20.sol";

contract ERC20__MockForRedeemsBuffer is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
