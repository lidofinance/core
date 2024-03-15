// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.9;

import {ERC20} from "@openzeppelin/contracts-v4.4/token/ERC20/ERC20.sol";

contract ERC20Token__MockForBurner is ERC20 {
  constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

  function mint(address to, uint256 amount) external {
    super._mint(to, amount);
  }
}
