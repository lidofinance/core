// SPDX-FileCopyrightText: 2020 Lido <info@lido.fi>

// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

interface IInterfaceResolver {
  function interfaceImplementer(bytes32 node, bytes4 interfaceID) external view returns (address);
}
