// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import "@openzeppelin/contracts-v4.4/token/ERC20/ERC20.sol";

contract ERC20OZMock is ERC20 {
    constructor(uint256 _initialSupply) ERC20("Mock ERC20 token", "mTKN") {
        _mint(msg.sender, _initialSupply);
    }
}
