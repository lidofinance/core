// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {StakingVault} from "./StakingVault.sol";

contract PredepositDepositGuardian {
    enum ValidatorStatus {
        NO_RECORD,
        AWAITING_PROOF,
        RESOLVED,
        WITHDRAWN
    }

    mapping(address nodeOperator => bytes32 validatorPubkeyHash) public nodeOperatorToValidators;
    mapping(bytes32 validatorPubkeyHash => ValidatorStatus validatorStatus) public validatorStatuses;
    mapping(bytes32 validatorPubkeyHash => bytes32 withdrawalCredentials) public wcRecords;

    function predeposit(address stakingVault, StakingVault.Deposit[] calldata deposits) external payable {
        if (msg.value % 1 ether != 0) revert PredepositMustBeMultipleOfOneEther();
        if (msg.value / 1 ether != deposits.length) revert PredepositMustBeOneEtherPerDeposit();
        if (msg.sender != StakingVault(payable(stakingVault)).nodeOperator()) revert MustBeNodeOperatorOfStakingVault();

        for (uint256 i = 0; i < deposits.length; i++) {
            StakingVault.Deposit calldata deposit = deposits[i];

            if (validatorStatuses[keccak256(deposit.pubkey)] != ValidatorStatus.AWAITING_PROOF) {
                revert MustBeNewValidatorPubkey();
            }

            nodeOperatorToValidators[msg.sender] = keccak256(deposit.pubkey);
            validatorStatuses[keccak256(deposit.pubkey)] = ValidatorStatus.AWAITING_PROOF;

            if (deposit.amount != 1 ether) revert PredepositMustBeOneEtherPerDeposit();
        }

        // we don't need to pass deposit root or signature because the msg.sender is deposit guardian itself
        StakingVault(payable(stakingVault)).depositToBeaconChain(deposits, bytes32(0), bytes(""));
    }

    function proveWithdrawalCredentials(
        bytes32[] calldata proof,
        bytes calldata validatorPubkey,
        bytes32 withdrawalCredentials
    ) external {
        // TODO: proof logic

        bytes32 validatorPubkeyHash = keccak256(validatorPubkey);
        wcRecords[validatorPubkeyHash] = withdrawalCredentials;
        validatorStatuses[validatorPubkeyHash] = ValidatorStatus.RESOLVED;
    }

    function deposit(address _stakingVault, StakingVault.Deposit[] calldata deposits) external payable {
        if (msg.sender != StakingVault(payable(_stakingVault)).nodeOperator())
            revert MustBeNodeOperatorOfStakingVault();

        for (uint256 i = 0; i < deposits.length; i++) {
            StakingVault.Deposit calldata deposit = deposits[i];

            if (validatorStatuses[keccak256(deposit.pubkey)] != ValidatorStatus.RESOLVED) {
                revert MustBeResolvedValidatorPubkey();
            }
        }

        // we don't need to pass deposit root or signature because the msg.sender is deposit guardian itself
        StakingVault(payable(_stakingVault)).depositToBeaconChain(deposits, bytes32(0), bytes(""));
    }

    function withdrawAsVaultOwner(address stakingVault, bytes[] calldata validatorPubkeys) external {
        if (msg.sender != StakingVault(payable(stakingVault)).owner()) revert MustBeVaultOwner();

        for (uint256 i = 0; i < validatorPubkeys.length; i++) {
            bytes32 validatorPubkeyHash = keccak256(validatorPubkeys[i]);

            if (validatorStatuses[validatorPubkeyHash] != ValidatorStatus.RESOLVED) {
                revert MustBeResolvedValidatorPubkey();
            }

            if (validatorStatuses[validatorPubkeyHash] == ValidatorStatus.WITHDRAWN) {
                revert ValidatorAlreadyWithdrawn();
            }

            if (wcRecords[validatorPubkeyHash] == StakingVault(payable(stakingVault)).withdrawalCredentials()) {
                revert ValidatorWithdrawalCredentialsMatchVaultWithdrawalCredentials();
            }

            msg.sender.call{value: 1 ether}("");

            validatorStatuses[validatorPubkeyHash] = ValidatorStatus.WITHDRAWN;
        }
    }

    function withdrawAsNodeOperator(bytes[] calldata validatorPubkeys) external {
        for (uint256 i = 0; i < validatorPubkeys.length; i++) {
            bytes32 validatorPubkeyHash = keccak256(validatorPubkeys[i]);

            if (validatorStatuses[validatorPubkeyHash] != ValidatorStatus.RESOLVED) {
                revert MustBeResolvedValidatorPubkey();
            }

            if (validatorStatuses[validatorPubkeyHash] == ValidatorStatus.WITHDRAWN) {
                revert ValidatorAlreadyWithdrawn();
            }

            if (nodeOperatorToValidators[msg.sender] != validatorPubkeyHash) {
                revert ValidatorMustBelongToSender();
            }

            msg.sender.call{value: 1 ether}("");

            validatorStatuses[validatorPubkeyHash] = ValidatorStatus.WITHDRAWN;
        }
    }

    error PredepositMustBeMultipleOfOneEther();
    error PredepositMustBeOneEtherPerDeposit();
    error MustBeNodeOperatorOfStakingVault();
    error MustBeNewValidatorPubkey();
    error WithdrawalFailed();
    error MustBeResolvedValidatorPubkey();
    error ValidatorMustBelongToSender();
    error MustBeVaultOwner();
    error ValidatorWithdrawalCredentialsMatchVaultWithdrawalCredentials();
    error ValidatorAlreadyWithdrawn();
}
