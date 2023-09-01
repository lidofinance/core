// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";


/**
  * @dev This is a mock. Don't use in production.
  */
contract ERC20WrongTransferMock is ERC20 {
    function mint(address account, uint256 value) public {
        _mint(account, value);
    }

    function transfer(address /*to*/, uint256 /*value*/) public returns (bool) {
        return false;
    }
}
