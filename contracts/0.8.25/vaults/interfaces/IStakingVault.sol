// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.0;

import {IDepositContract} from "contracts/common/interfaces/IDepositContract.sol";

/**
 * @title IStakingVault
 * @author Lido
 * @notice Interface for the `StakingVault` contract
 */
interface IStakingVault {
    /**
     * @notice validator deposit from the `StakingVault` to the beacon chain
     * @dev withdrawal credentials are provided by the vault
     * @custom:pubkey The validator's BLS public key (48 bytes)
     * @custom:signature BLS signature of the deposit data (96 bytes)
     * @custom:amount Amount of ETH to deposit in wei (must be a multiple of 1 ETH)
     * @custom:depositDataRoot The root hash of the deposit data per ETH beacon spec
     */
    struct Deposit {
        bytes pubkey;
        bytes signature;
        uint256 amount;
        bytes32 depositDataRoot;
    }

    function DEPOSIT_CONTRACT() external view returns (IDepositContract);
    function initialize(address _owner, address _nodeOperator, address _depositor) external;
    function version() external pure returns (uint64);
    function getInitializedVersion() external view returns (uint64);
    function withdrawalCredentials() external view returns (bytes32);

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function acceptOwnership() external;
    function transferOwnership(address _newOwner) external;

    function nodeOperator() external view returns (address);
    function depositor() external view returns (address);
    function isOssified() external view returns (bool);
    function calculateValidatorWithdrawalFee(uint256 _keysCount) external view returns (uint256);
    function fund() external payable;
    function withdraw(address _recipient, uint256 _ether) external;

    function beaconChainDepositsPaused() external view returns (bool);
    function pauseBeaconChainDeposits() external;
    function resumeBeaconChainDeposits() external;
    function depositToBeaconChain(Deposit[] calldata _deposits) external;

    function requestValidatorExit(bytes calldata _pubkeys) external;
    function triggerValidatorWithdrawals(bytes calldata _pubkeys, uint64[] calldata _amounts, address _refundRecipient) external payable;
    function ejectValidators(bytes calldata _pubkeys, address _refundRecipient) external payable;
    function setDepositor(address _depositor) external;
    function ossify() external;
}
