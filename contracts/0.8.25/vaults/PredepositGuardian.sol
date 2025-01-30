// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {StakingVault} from "./StakingVault.sol";

// TODO: think about naming. It's not a deposit guardian, it's the depositor itself
// TODO: minor UX improvement: perhaps there's way to reuse predeposits for a different validator without withdrawing
contract PredepositGuardian {
    uint256 public constant PREDEPOSIT_AMOUNT = 1 ether;

    mapping(bytes32 validatorId => bool isPreDeposited) public validatorPredeposits;
    mapping(bytes32 validatorId => bytes32 withdrawalCredentials) public validatorWithdrawalCredentials;

    // Question: predeposit is permissionless, i.e. the msg.sender doesn't have to be the node operator,
    // however, the deposit will still revert if it wasn't signed with the validator private key
    function predeposit(StakingVault stakingVault, StakingVault.Deposit[] calldata deposits) external payable {
        if (deposits.length == 0) revert PredepositNoDeposits();
        if (msg.value % PREDEPOSIT_AMOUNT != 0) revert PredepositValueNotMultipleOfOneEther();
        if (msg.value / PREDEPOSIT_AMOUNT != deposits.length) revert PredepositValueNotMatchingNumberOfDeposits();

        for (uint256 i = 0; i < deposits.length; i++) {
            StakingVault.Deposit calldata deposit = deposits[i];

            bytes32 validatorId = keccak256(deposit.pubkey);

            // cannot predeposit a validator that is already predeposited
            if (validatorPredeposits[validatorId]) revert PredepositValidatorAlreadyPredeposited();

            // cannot predeposit a validator that has withdrawal credentials already proven
            if (validatorWithdrawalCredentials[validatorId] != bytes32(0))
                revert PredepositValidatorWithdrawalCredentialsAlreadyProven();

            // cannot predeposit a validator with a deposit amount that is not 1 ether
            if (deposit.amount != PREDEPOSIT_AMOUNT) revert PredepositDepositAmountInvalid();

            validatorPredeposits[validatorId] = true;
        }

        stakingVault.depositToBeaconChain(deposits);
    }

    function proveValidatorWithdrawalCredentials(
        bytes32[] calldata /* proof */,
        bytes calldata _pubkey,
        bytes32 _withdrawalCredentials
    ) external {
        // TODO: proof logic
        // revert if proof is invalid

        validatorWithdrawalCredentials[keccak256(_pubkey)] = _withdrawalCredentials;
    }

    function depositToProvenValidators(
        StakingVault _stakingVault,
        StakingVault.Deposit[] calldata _deposits
    ) external payable {
        if (msg.sender != _stakingVault.nodeOperator()) revert DepositSenderNotNodeOperator();

        for (uint256 i = 0; i < _deposits.length; i++) {
            StakingVault.Deposit calldata deposit = _deposits[i];
            bytes32 validatorId = keccak256(deposit.pubkey);

            if (validatorWithdrawalCredentials[validatorId] != _stakingVault.withdrawalCredentials()) {
                revert DepositToUnprovenValidator();
            }
        }

        _stakingVault.depositToBeaconChain(_deposits);
    }

    // called by the staking vault owner if the predeposited validator has a different withdrawal credentials than the vault's withdrawal credentials,
    // i.e. node operator was malicious
    function withdrawDisprovenPredeposits(
        StakingVault _stakingVault,
        bytes32[] calldata _validatorIds,
        address _recipient
    ) external {
        if (msg.sender != _stakingVault.owner()) revert WithdrawSenderNotStakingVaultOwner();
        if (_recipient == address(0)) revert WithdrawRecipientZeroAddress();

        uint256 validatorsLength = _validatorIds.length;
        for (uint256 i = 0; i < validatorsLength; i++) {
            bytes32 validatorId = _validatorIds[i];

            // cannot withdraw predeposit for a validator that is not pre-deposited
            if (!validatorPredeposits[validatorId]) {
                revert WithdrawValidatorNotPreDeposited();
            }

            // cannot withdraw predeposit for a validator that has withdrawal credentials matching the vault's withdrawal credentials
            if (validatorWithdrawalCredentials[validatorId] == _stakingVault.withdrawalCredentials()) {
                revert WithdrawValidatorWithdrawalCredentialsMatchStakingVault();
            }

            // set flag to false to prevent double withdrawal
            validatorPredeposits[validatorId] = false;

            (bool success, ) = _recipient.call{value: 1 ether}("");
            if (!success) revert WithdrawValidatorTransferFailed();
        }
    }

    // called by the node operator if the predeposited validator has the same withdrawal credentials as the vault's withdrawal credentials,
    // i.e. node operator was honest
    function withdrawProvenPredeposits(
        StakingVault _stakingVault,
        bytes32[] calldata _validatorIds,
        address _recipient
    ) external {
        uint256 validatorsLength = _validatorIds.length;
        for (uint256 i = 0; i < validatorsLength; i++) {
            bytes32 validatorId = _validatorIds[i];

            if (msg.sender != _stakingVault.nodeOperator()) {
                revert WithdrawSenderNotNodeOperator();
            }

            // cannot withdraw predeposit for a validator that is not pre-deposited
            if (!validatorPredeposits[validatorId]) {
                revert WithdrawValidatorNotPreDeposited();
            }

            // cannot withdraw predeposit for a validator that has withdrawal credentials not matching the vault's withdrawal credentials
            if (validatorWithdrawalCredentials[validatorId] != _stakingVault.withdrawalCredentials()) {
                revert WithdrawValidatorWithdrawalCredentialsNotMatchingStakingVault();
            }

            // set flag to false to prevent double withdrawal
            validatorPredeposits[validatorId] = false;

            (bool success, ) = _recipient.call{value: 1 ether}("");
            if (!success) revert WithdrawValidatorTransferFailed();
        }
    }

    error PredepositNoDeposits();
    error PredepositValueNotMultipleOfOneEther();
    error PredepositValueNotMatchingNumberOfDeposits();
    error PredepositNodeOperatorNotMatching();
    error PredepositValidatorAlreadyPredeposited();
    error PredepositValidatorWithdrawalCredentialsAlreadyProven();
    error PredepositDepositAmountInvalid();
    error ValidatorNotPreDeposited();
    error DepositSenderNotNodeOperator();
    error DepositToUnprovenValidator();
    error WithdrawSenderNotStakingVaultOwner();
    error WithdrawRecipientZeroAddress();
    error WithdrawValidatorNotPreDeposited();
    error WithdrawValidatorWithdrawalCredentialsMatchStakingVault();
    error WithdrawValidatorTransferFailed();
    error WithdrawValidatorWithdrawalCredentialsNotMatchingStakingVault();
    error WithdrawSenderNotNodeOperator();
    error WithdrawValidatorDoesNotBelongToNodeOperator();
}
