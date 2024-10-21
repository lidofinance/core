// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

/// @title IVault
/// @notice Interface for the Vault contract
interface IVault {
    /// @notice Emitted when the vault is funded
    /// @param sender The address that sent ether
    /// @param amount The amount of ether funded
    event Funded(address indexed sender, uint256 amount);

    /// @notice Emitted when ether is withdrawn from the vault
    /// @param sender The address that initiated the withdrawal
    /// @param recipient The address that received the withdrawn ETH
    /// @param amount The amount of ETH withdrawn
    event Withdrawn(address indexed sender, address indexed recipient, uint256 amount);

    /// @notice Emitted when deposits are made to the Beacon Chain deposit contract
    /// @param sender The address that initiated the deposits
    /// @param numberOfDeposits The number of deposits made
    /// @param amount The total amount of ETH deposited
    event Deposited(address indexed sender, uint256 numberOfDeposits, uint256 amount);

    /// @notice Emitted when validator exits are triggered
    /// @param sender The address that triggered the exits
    /// @param numberOfValidators The number of validators exited
    event ValidatorsExited(address indexed sender, uint256 numberOfValidators);

    /// @notice Emitted when execution rewards are received
    /// @param sender The address that sent the rewards
    /// @param amount The amount of rewards received
    event ExecRewardsReceived(address indexed sender, uint256 amount);

    /// @notice Error thrown when a zero value is provided
    /// @param name The name of the variable that was zero
    error Zero(string name);

    /// @notice Error thrown when a transfer fails
    /// @param recipient The intended recipient of the failed transfer
    /// @param amount The amount that failed to transfer
    error TransferFailed(address recipient, uint256 amount);

    /// @notice Error thrown when there's insufficient balance for an operation
    /// @param balance The current balance
    error InsufficientBalance(uint256 balance);

    /// @notice Get the withdrawal credentials for the deposit
    /// @return The withdrawal credentials as a bytes32
    function getWithdrawalCredentials() external view returns (bytes32);

    /// @notice Fund the vault with ether
    function fund() external payable;

    /// @notice Deposit ether to the Beacon Chain deposit contract
    /// @param _numberOfDeposits The number of deposits made
    /// @param _pubkeys The array of public keys of the validators
    /// @param _signatures The array of signatures of the validators
    function deposit(uint256 _numberOfDeposits, bytes calldata _pubkeys, bytes calldata _signatures) external;

    /// @notice Trigger exits for a specified number of validators
    /// @param _numberOfValidators The number of validator keys to exit
    function exitValidators(uint256 _numberOfValidators) external;

    /// @notice Withdraw ether from the vault
    /// @param _recipient The address to receive the withdrawn ether
    /// @param _amount The amount of ether to withdraw
    function withdraw(address _recipient, uint256 _amount) external;
}
