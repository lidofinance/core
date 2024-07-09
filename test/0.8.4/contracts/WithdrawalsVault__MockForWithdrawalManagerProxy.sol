// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.4;

contract WithdrawalsVault__MockForWithdrawalManagerProxy {
  function mock__changeNumber(uint256 someNumber) external {
    bytes32 slot = keccak256("someNumberSlot");

    // solhint-disable-next-line no-inline-assembly
    assembly {
      sstore(slot, someNumber)
    }
  }
}
