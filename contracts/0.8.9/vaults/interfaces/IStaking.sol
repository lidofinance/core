// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

/// Basic staking vault interface
interface IStaking {
    event Deposit(address indexed sender, uint256 amount);
    event Withdrawal(address indexed receiver, uint256 amount);
    event ValidatorsCreated(address indexed operator, uint256 number);
    event ELRewardsReceived(address indexed sender, uint256 amount);

    function getWithdrawalCredentials() external view returns (bytes32);

    function deposit() external payable;
    receive() external payable;
    function withdraw(address receiver, uint256 etherToWithdraw) external;

    function createValidators(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) external;
}
