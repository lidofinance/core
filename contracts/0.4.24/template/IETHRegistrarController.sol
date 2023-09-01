// SPDX-FileCopyrightText: 2020 Lido <info@lido.fi>

// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

interface IETHRegistrarController {
  function MIN_REGISTRATION_DURATION() external view returns (uint256);
  function minCommitmentAge() external view returns (uint256);
  function maxCommitmentAge() external view returns (uint256);

  function rentPrice(string name, uint256 duration) external view returns (uint256);
  function valid(string name) external pure returns (bool);
  function available(string name) external view returns (bool);
  function makeCommitment(string name, address owner, bytes32 secret) external pure returns (bytes32);
  function commit(bytes32 commitment) external;
  function register(string name, address owner, uint256 duration, bytes32 secret) external payable;
}
