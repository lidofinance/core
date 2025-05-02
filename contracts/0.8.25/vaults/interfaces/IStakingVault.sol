// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IDepositContract} from "contracts/0.8.25/interfaces/IDepositContract.sol";

/**
 * @notice validator deposit from the `StakingVault` to the beacon chain
 * @dev withdrawal credentials are provided by the vault
 * @custom:pubkey The validator's BLS public key (48 bytes)
 * @custom:signature BLS signature of the deposit data (96 bytes)
 * @custom:amount Amount of ETH to deposit in wei (must be a multiple of 1 ETH)
 * @custom:depositDataRoot The root hash of the deposit data per ETH beacon spec
 */
struct StakingVaultDeposit {
    bytes pubkey;
    bytes signature;
    uint256 amount;
    bytes32 depositDataRoot;
}

/**
 * @title IStakingVault
 * @author Lido
 * @notice Interface for the `StakingVault` contract
 */
interface IStakingVault {
    function initialize(address _owner) external;
    function version() external pure returns (uint64);
    function getInitializedVersion() external view returns (uint64);
    function withdrawalCredentials() external view returns (bytes32);
    function owner() external view returns (address);
    function isOssified() external view returns (bool);
    function calculateValidatorWithdrawalFee(uint256 _keysCount) external view returns (uint256);
    function withdraw(address _recipient, uint256 _ether) external;
    function ossify() external;
    function requestValidatorExit(bytes calldata _pubkeys) external;
    function triggerValidatorWithdrawal(bytes calldata _pubkeys, uint64[] calldata _amounts, address _refundRecipient) external payable;
}
