// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.4;

contract Impl__MockForERC1967Proxy {
  function writeToStorage(bytes32 slot, bytes32 value) external {
    assembly {
      sstore(slot, value)
    }
  }

  event Received();
  receive() external payable {
    emit Received();
  }
}
