// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import { ERC20 } from "@openzeppelin/contracts-v5.0.2/token/ERC20/ERC20.sol";

contract StETH__MockForDashboard is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function transferSharesFrom(address from, address to, uint256 amount) external returns (uint256) {
        _transfer(from, to, amount);
        return amount;
    }
}



