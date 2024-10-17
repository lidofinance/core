// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

/// Basic staking vault interface
interface IStaking {
    event Deposit(address indexed sender, uint256 amount);
    event Withdrawal(address indexed receiver, uint256 amount);
    event ValidatorsTopup(address indexed operator, uint256 numberOfKeys, uint256 ethAmount);
    event ValidatorExitTriggered(address indexed operator, uint256 numberOfKeys);
    event ELRewards(address indexed sender, uint256 amount);

    function getWithdrawalCredentials() external view returns (bytes32);

    function deposit() external payable;
    receive() external payable;
    function withdraw(address receiver, uint256 etherToWithdraw) external;

    function topupValidators(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) external;

    function triggerValidatorExit(uint256 _numberOfKeys) external;
}
