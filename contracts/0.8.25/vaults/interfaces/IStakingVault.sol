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
    function DEPOSIT_CONTRACT() external view returns (IDepositContract);

    function initialize(address _owner, address _operator, address _depositor, bytes calldata _params) external;
    function version() external pure returns (uint64);
    function owner() external view returns (address);
    function getInitializedVersion() external view returns (uint64);
    function vaultHub() external view returns (address);
    function nodeOperator() external view returns (address);
    function depositor() external view returns (address);
    function withdraw(address _recipient, uint256 _ether) external;
    function withdrawalCredentials() external view returns (bytes32);
    function beaconChainDepositsPaused() external view returns (bool);
    function pauseBeaconChainDeposits() external;
    function resumeBeaconChainDeposits() external;
    function depositToBeaconChain(StakingVaultDeposit[] calldata _deposits) external;
    function requestValidatorExit(bytes calldata _pubkeys) external;
    function calculateValidatorWithdrawalFee(uint256 _keysCount) external view returns (uint256);
    function triggerValidatorWithdrawal(bytes calldata _pubkeys, uint64[] calldata _amounts, address _refundRecipient) external payable;
    function authorizeLidoVaultHub() external;
    function deauthorizeLidoVaultHub() external;
    function vaultHubAuthorized() external view returns (bool);
    function ossifyStakingVault() external;
    function ossified() external view returns (bool);
    function setDepositor(address _depositor) external;
}
