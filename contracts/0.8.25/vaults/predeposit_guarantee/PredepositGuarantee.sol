// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Validator} from "../../lib/SSZ.sol";

import {CLProofVerifier} from "./CLProofVerifier.sol";
import {StakingVault} from "../StakingVault.sol";

struct ValidatorProof {
    Validator validator;
    bytes32[] proof;
}

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
    mapping(address nodeOperator => address delegate) public nodeOperatorDelegate;

    mapping(bytes validatorPubkey => ValidatorStatus validatorStatus) public validatorStatuses;
    mapping(bytes validatorPubkey => StakingVault) public validatorStakingVault;
    // node operator can be taken from vault,but this prevents malicious vault from changing node operator midflight
    mapping(bytes validatorPubkey => address nodeOperator) public validatorToNodeOperator;

    /// NO Balance operations

    function topUpNodeOperatorCollateral(address _nodeOperator) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        _topUpNodeOperatorCollateral(_nodeOperator);
    }

    function withdrawNodeOperatorCollateral(address _nodeOperator, uint256 _amount, address _recipient) external {
        if (_amount == 0) revert ZeroArgument("amount");
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        _isValidNodeOperatorCaller(_nodeOperator);

        if (nodeOperatorCollateral[_nodeOperator] < _amount) revert NotEnoughUnlockedCollateralToWithdraw();

        nodeOperatorCollateral[_nodeOperator] -= _amount;
        (bool success, ) = _recipient.call{value: uint256(_amount)}("");

        if (!success) revert WithdrawalFailed();

        // TODO: event
    }

    // delegation

    function delegateNodeOperatorCollateral(address _delegate) external {
        nodeOperatorDelegate[msg.sender] = _delegate;
        //  TODO: event
    }

    /// Deposit operations

    function predeposit(StakingVault _stakingVault, StakingVault.Deposit[] calldata _deposits) external payable {
        if (_deposits.length == 0) revert PredepositNoDeposits();

        address _nodeOperator = _stakingVault.nodeOperator();
        if (msg.sender != _nodeOperator) revert MustBeNodeOperator();

        // optional top up
        if (msg.value != 0) {
            _topUpNodeOperatorCollateral(_nodeOperator);
        }

        uint256 totalDepositAmount = PREDEPOSIT_AMOUNT * _deposits.length;

        if (nodeOperatorCollateral[_nodeOperator] < totalDepositAmount)
            revert NotEnoughUnlockedCollateralToPredeposit();

        for (uint256 i = 0; i < _deposits.length; i++) {
            StakingVault.Deposit calldata _deposit = _deposits[i];

            if (validatorStatuses[_deposit.pubkey] != ValidatorStatus.NO_RECORD) {
                revert MustBeNewValidatorPubkey();
            }

            // cannot predeposit a validator with a deposit amount that is not 1 ether
            if (_deposit.amount != PREDEPOSIT_AMOUNT) revert PredepositDepositAmountInvalid();

            validatorStatuses[_deposit.pubkey] = ValidatorStatus.AWAITING_PROOF;
            validatorStakingVault[_deposit.pubkey] = _stakingVault;
            validatorToNodeOperator[_deposit.pubkey] = _nodeOperator;
        }

        nodeOperatorCollateral[_nodeOperator] -= totalDepositAmount;
        _stakingVault.depositToBeaconChain(_deposits);
        // TODO: event
    }

    function proveValidatorWC(
        Validator calldata _validator,
        bytes32[] calldata _proof,
        uint64 _beaconBlockTimestamp
    ) external {
        _processWCProof(_validator, _proof, _beaconBlockTimestamp);
    }

    function depositToProvenValidators(
        StakingVault _stakingVault,
        StakingVault.Deposit[] calldata _deposits
    ) public payable {
        if (msg.sender != _stakingVault.nodeOperator()) {
            revert MustBeNodeOperator();
        }

        for (uint256 i = 0; i < _deposits.length; i++) {
            StakingVault.Deposit calldata _deposit = _deposits[i];

            if (validatorStatuses[_deposit.pubkey] != ValidatorStatus.PROVED) {
                revert DepositToUnprovenValidator();
            }

            if (validatorStakingVault[_deposit.pubkey] != _stakingVault) {
                revert DepositToWrongVault();
            }
        }

        _stakingVault.depositToBeaconChain(_deposits);
    }

    /**
     @notice happy path shortcut for the node operator that allows:
      - prove validators to free up collateral
      - optionally top up collateral
      - trigger deposit to proven validators via vault
     NB! proven and deposited validators sets don't have to match */
    function proveAndDeposit(
        ValidatorProof[] calldata _validatorProofs,
        StakingVault.Deposit[] calldata _deposits,
        StakingVault _stakingVault,
        uint64 _beaconBlockTimestamp
    ) external payable {
        for (uint256 i = 0; i < _validatorProofs.length; i++) {
            ValidatorProof calldata _validatorProof = _validatorProofs[i];
            _processWCProof(_validatorProof.validator, _validatorProof.proof, _beaconBlockTimestamp);
        }

        depositToProvenValidators(_stakingVault, _deposits);
    }

    // called by the staking vault owner if the predeposited validator was proven invalid
    // i.e. node operator was malicious and has stolen vault ether
    function withdrawDisprovenCollateral(bytes calldata validatorPubkey, address _recipient) external {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        if (_recipient == address(validatorStakingVault[validatorPubkey])) revert WithdrawToVaultNotAllowed();

        if (validatorStatuses[validatorPubkey] != ValidatorStatus.PROVED_INVALID) revert ValidatorNotProvenInvalid();

        if (msg.sender != validatorStakingVault[validatorPubkey].owner()) revert WithdrawSenderNotStakingVaultOwner();

        validatorStatuses[validatorPubkey] = ValidatorStatus.WITHDRAWN;

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

    function _processWCProof(
        Validator calldata _validator,
        bytes32[] calldata _proof,
        uint64 _beaconBlockTimestamp
    ) internal {
        if (validatorStatuses[_validator.pubkey] != ValidatorStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited();
        }

        if (
            address(validatorStakingVault[_validator.pubkey]) ==
            _wcToAddress(_validateWCProof(_validator, _proof, _beaconBlockTimestamp))
        ) {
            nodeOperatorCollateral[validatorToNodeOperator[_validator.pubkey]] += PREDEPOSIT_AMOUNT;
            validatorStatuses[_validator.pubkey] = ValidatorStatus.PROVED;
            // TODO: positive events
        } else {
            validatorStatuses[_validator.pubkey] = ValidatorStatus.PROVED_INVALID;
            // TODO: negative events
        }
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
    error WithdrawToVaultNotAllowed();
    /// withdrawal generic
    error WithdrawalFailed();

    // auth
    error MustBeNodeOperatorOrDelegate();
    error MustBeNodeOperator();

    // general
    error ZeroArgument(string argument);
}
