// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Validator} from "../lib/SSZ.sol";

import {CLProofVerifier} from "./CLProofVerifier.sol";
import {StakingVault} from "../vaults/StakingVault.sol";

contract PredepositGuarantee is CLProofVerifier {
    uint256 public constant PREDEPOSIT_AMOUNT = 1 ether;

    enum ValidatorStatus {
        NO_RECORD,
        AWAITING_PROOF,
        PROVED,
        PROVED_INVALID,
        WITHDRAWN
    }

    mapping(address nodeOperator => uint256) public nodeOperatorCollateral;
    mapping(address nodeOperator => uint256) public nodeOperatorCollateralLocked;
    mapping(address nodeOperator => address delegate) public nodeOperatorDelegate;

    mapping(bytes32 validatorPubkeyHash => ValidatorStatus validatorStatus) public validatorStatuses;
    mapping(bytes32 validatorPubkeyHash => StakingVault) public validatorStakingVault;
    // node operator can be taken from vault,but this prevents malicious vault from changing node operator midflight
    mapping(bytes32 validatorPubkeyHash => address nodeOperator) public validatorToNodeOperator;

    /// views

    function nodeOperatorBalance(address nodeOperator) external view returns (uint256, uint256) {
        return (nodeOperatorCollateral[nodeOperator], nodeOperatorCollateralLocked[nodeOperator]);
    }

    /// NO Balance operations

    function topUpNodeOperatorCollateral(address _nodeOperator) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        _topUpNodeOperatorCollateral(_nodeOperator);
    }

    function withdrawNodeOperatorCollateral(address _nodeOperator, uint256 _amount, address _recipient) external {
        if (_amount == 0) revert ZeroArgument("amount");
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        _isValidNodeOperatorCaller(_nodeOperator);

        if (nodeOperatorCollateral[_nodeOperator] - nodeOperatorCollateralLocked[_nodeOperator] >= _amount)
            revert NotEnoughUnlockedCollateralToWithdraw();

        nodeOperatorCollateral[_nodeOperator] -= _amount;
        (bool success, ) = _recipient.call{value: _amount}("");

        if (!success) revert WithdrawalFailed();

        // TODO: event
    }

    // delegation

    function delegateNodeOperator(address _delegate) external {
        nodeOperatorDelegate[msg.sender] = _delegate;
        //  TODO: event
    }

    /// Deposit operations

    function predeposit(StakingVault _stakingVault, StakingVault.Deposit[] calldata _deposits) external payable {
        if (_deposits.length == 0) revert PredepositNoDeposits();

        address _nodeOperator = _stakingVault.nodeOperator();
        _isValidNodeOperatorCaller(_nodeOperator);

        // optional top up
        if (msg.value != 0) {
            _topUpNodeOperatorCollateral(_nodeOperator);
        }

        uint256 unlockedCollateral = nodeOperatorCollateral[_nodeOperator] -
            nodeOperatorCollateralLocked[_nodeOperator];

        uint256 totalDepositAmount = PREDEPOSIT_AMOUNT * _deposits.length;

        if (unlockedCollateral < totalDepositAmount) revert NotEnoughUnlockedCollateralToPredeposit();

        for (uint256 i = 0; i < _deposits.length; i++) {
            StakingVault.Deposit calldata _deposit = _deposits[i];

            bytes32 validatorId = keccak256(_deposit.pubkey);

            if (validatorStatuses[validatorId] != ValidatorStatus.NO_RECORD) {
                revert MustBeNewValidatorPubkey();
            }

            // cannot predeposit a validator with a deposit amount that is not 1 ether
            if (_deposit.amount != PREDEPOSIT_AMOUNT) revert PredepositDepositAmountInvalid();

            validatorStatuses[validatorId] = ValidatorStatus.AWAITING_PROOF;
            validatorStakingVault[validatorId] = _stakingVault;
            validatorToNodeOperator[validatorId] = _nodeOperator;
        }

        nodeOperatorCollateralLocked[_nodeOperator] += totalDepositAmount;
        _stakingVault.depositToBeaconChain(_deposits);
        // TODO: event
    }

    function proveValidatorPreDeposit(
        Validator calldata _validator,
        bytes32[] calldata _proof,
        uint64 _beaconBlockTimestamp
    ) external {
        bytes32 _validatorId = keccak256(_validator.pubkey);
        // check that the validator is predeposited
        if (validatorStatuses[_validatorId] != ValidatorStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited();
        }

        if (address(validatorStakingVault[_validatorId]) != _wcToAddress(_validator.withdrawalCredentials)) {
            revert WithdrawalCredentialsAreInvalid();
        }

        _validateProof(_validator, _proof, _beaconBlockTimestamp);

        nodeOperatorCollateralLocked[validatorToNodeOperator[_validatorId]] -= PREDEPOSIT_AMOUNT;
        validatorStatuses[_validatorId] = ValidatorStatus.PROVED;

        // TODO: event
    }

    function proveInvalidValidatorPreDeposit(
        Validator calldata _validator,
        bytes32[] calldata _proof,
        bytes32 _invalidWC,
        uint64 _beaconBlockTimestamp
    ) external {
        bytes32 _validatorId = keccak256(_validator.pubkey);
        // check that the validator is predeposited
        if (validatorStatuses[_validatorId] != ValidatorStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited();
        }

        if (address(validatorStakingVault[_validatorId]) == _wcToAddress(_validator.withdrawalCredentials)) {
            revert WithdrawalCredentialsAreValid();
        }

        _validateProof(_validator, _proof, _beaconBlockTimestamp);

        validatorStatuses[_validatorId] = ValidatorStatus.PROVED_INVALID;

        // TODO: event
    }

    function depositToProvenValidators(
        StakingVault _stakingVault,
        StakingVault.Deposit[] calldata _deposits
    ) external payable {
        _isValidNodeOperatorCaller(_stakingVault.nodeOperator());

        for (uint256 i = 0; i < _deposits.length; i++) {
            StakingVault.Deposit calldata _deposit = _deposits[i];
            bytes32 _validatorId = keccak256(_deposit.pubkey);

            if (validatorStatuses[_validatorId] != ValidatorStatus.PROVED) {
                revert DepositToUnprovenValidator();
            }

            if (validatorStakingVault[_validatorId] != _stakingVault) {
                revert DepositToWrongVault();
            }
        }

        _stakingVault.depositToBeaconChain(_deposits);
    }

    // called by the staking vault owner if the predeposited validator has a different withdrawal credentials than the vault's withdrawal credentials,
    // i.e. node operator was malicio

    function withdrawDisprovenCollateral(bytes32 _validatorId, address _recipient) external {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        address _nodeOperator = validatorToNodeOperator[_validatorId];
        if (validatorStatuses[_validatorId] != ValidatorStatus.PROVED_INVALID) revert ValidatorNotProvenInvalid();

        if (msg.sender != validatorStakingVault[_validatorId].owner()) revert WithdrawSenderNotStakingVaultOwner();

        nodeOperatorCollateralLocked[_nodeOperator] -= PREDEPOSIT_AMOUNT;
        nodeOperatorCollateral[_nodeOperator] -= PREDEPOSIT_AMOUNT;
        validatorStatuses[_validatorId] = ValidatorStatus.WITHDRAWN;

        (bool success, ) = _recipient.call{value: PREDEPOSIT_AMOUNT}("");
        if (!success) revert WithdrawalFailed();

        //TODO: events
    }

    /// Internal functions

    function _topUpNodeOperatorCollateral(address _nodeOperator) internal {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");
        nodeOperatorCollateral[_nodeOperator] += msg.value;
        // TODO: event
    }

    function _isValidNodeOperatorCaller(address _nodeOperator) internal view {
        if (msg.sender != _nodeOperator && nodeOperatorDelegate[_nodeOperator] != msg.sender)
            revert MustBeNodeOperatorOrDelegate();
    }

    function _wcToAddress(bytes32 _withdrawalCredentials) internal pure returns (address) {
        return address(uint160(uint256(_withdrawalCredentials)));
    }

    // predeposit errors
    error PredepositNoDeposits();
    error PredepositValueNotMultipleOfPrediposit();
    error PredepositDepositAmountInvalid();
    error MustBeNewValidatorPubkey();
    error NotEnoughUnlockedCollateralToPredeposit();

    // depositing errors
    error DepositToUnprovenValidator();
    error DepositToWrongVault();
    error ValidatorNotPreDeposited();

    // prove
    error WithdrawalCredentialsAreInvalid();

    // withdrawal proven
    error NotEnoughUnlockedCollateralToWithdraw();

    // withdrawal disproven
    error ValidatorNotProvenInvalid();
    error WithdrawSenderNotStakingVaultOwner();
    error WithdrawSenderNotNodeOperator();
    error WithdrawValidatorDoesNotBelongToNodeOperator();
    error WithdrawalCollateralOfWrongVault();
    error WithdrawalCredentialsAreValid();
    /// withdrawal generic
    error WithdrawalFailed();

    // auth
    error MustBeNodeOperatorOrDelegate();

    // general
    error ZeroArgument(string argument);
}
