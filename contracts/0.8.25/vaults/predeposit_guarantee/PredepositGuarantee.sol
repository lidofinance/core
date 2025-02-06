// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {CLProofVerifier, ValidatorWitness, GIndex} from "./CLProofVerifier.sol";

import {IStakingVaultOwnable} from "../interfaces/IStakingVault.sol";

contract PredepositGuarantee is CLProofVerifier {
    uint128 public constant PREDEPOSIT_AMOUNT = 1 ether;

    enum BondStatus {
        NO_RECORD,
        AWAITING_PROOF,
        PROVED,
        PROVED_INVALID,
        WITHDRAWN
    }

    struct NodeOperatorBond {
        uint128 total;
        uint128 locked;
    }

    struct ValidatorStatus {
        BondStatus bondStatus;
        IStakingVaultOwnable stakingVault;
        address nodeOperator;
    }

    // Events
    event NodeOperatorBondToppedUp(address indexed nodeOperator, uint256 amount);
    event NodeOperatorBondWithdrawn(address indexed nodeOperator, uint256 amount, address indexed recipient);
    event NodeOperatorVoucherSet(address indexed nodeOperator, address indexed voucher);
    event ValidatorPreDeposited(address indexed nodeOperator, address indexed stakingVault, uint256 numberOfDeposits, uint256 totalDepositAmount);
    event ValidatorProven(address indexed nodeOperator, bytes indexed validatorPubkey, address indexed stakingVault, bytes32 withdrawalCredentials);
    event ValidatorDisproven(address indexed nodeOperator, bytes indexed validatorPubkey, address indexed stakingVault, bytes32 withdrawalCredentials);
    event ValidatorDisprovenWithdrawn(address indexed nodeOperator, bytes indexed validatorPubkey, address indexed stakingVault, address recipient);

    constructor(GIndex _gIFirstValidator) CLProofVerifier(_gIFirstValidator) {}

    mapping(address nodeOperator => NodeOperatorBond bond) public nodeOperatorBonds;
    mapping(address nodeOperator => address voucher) public nodeOperatorVoucher;

    mapping(bytes validatorPubkey => ValidatorStatus validatorStatus) public validatorStatuses;

    // View functions

    function nodeOperatorBond(address _nodeOperator) external view returns (NodeOperatorBond memory) {
        return nodeOperatorBonds[_nodeOperator];
    }

    function nodeOperatorVoucherAddress(address _nodeOperator) external view returns (address) {
        return nodeOperatorVoucher[_nodeOperator];
    }

    function validatorStatus(bytes calldata _validatorPubkey) external view returns (ValidatorStatus memory) {
        return validatorStatuses[_validatorPubkey];
    }

    /// NO Balance operations

    function topUpNodeOperatorBond(address _nodeOperator) external payable {
        _topUpNodeOperatorCollateral(_nodeOperator, msg.value);
    }

    function withdrawNodeOperatorBond(address _nodeOperator, uint128 _amount, address _recipient) external {
        if (_amount == 0) revert ZeroArgument("amount");
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        _validateNodeOperatorCaller(_nodeOperator);

        uint256 unlockedCollateral = nodeOperatorBonds[_nodeOperator].total - nodeOperatorBonds[_nodeOperator].locked;

        if (unlockedCollateral < _amount)
            revert NotEnoughUnlockedCollateralToWithdraw(unlockedCollateral, _amount);

        nodeOperatorBonds[_nodeOperator].total -= _amount;
        (bool success, ) = _recipient.call{value: uint256(_amount)}("");
        if (!success) revert WithdrawalFailed();

        emit NodeOperatorBondWithdrawn(_nodeOperator, _amount, _recipient);
    }

    function setNodeOperatorVoucher(address _voucher) external {
        NodeOperatorBond storage bond = nodeOperatorBonds[msg.sender];

        if (_voucher == msg.sender) revert CannotSetSelfAsVoucher();

        if (bond.locked != 0) revert BondMustBeFullyUnlocked();

        if (bond.total > 0 && nodeOperatorVoucher[msg.sender] != address(0)) {
            uint256 bondAmount = bond.total;
            nodeOperatorBonds[msg.sender].total = 0;
            (bool success, ) = nodeOperatorVoucher[msg.sender].call{value: bondAmount}("");

            // voucher can block change?
            if (!success) revert WithdrawalFailed();
        }

        nodeOperatorVoucher[msg.sender] = _voucher;

        emit NodeOperatorVoucherSet(msg.sender, _voucher);
    }

    /// Deposit operations

    function predeposit(
        IStakingVaultOwnable _stakingVault,
        IStakingVaultOwnable.Deposit[] calldata _deposits
    ) external payable {
        if (_deposits.length == 0) revert PredepositNoDeposits();

        address _nodeOperator = _stakingVault.nodeOperator();
        if (msg.sender != _nodeOperator) revert MustBeNodeOperator();

        // optional top up
        if (msg.value != 0) {
            _topUpNodeOperatorCollateral(_nodeOperator, msg.value);
        }

        uint128 totalDepositAmount = PREDEPOSIT_AMOUNT * uint128(_deposits.length);
        uint256 unlockedCollateral = nodeOperatorBonds[_nodeOperator].total - nodeOperatorBonds[_nodeOperator].locked;

        if (unlockedCollateral < totalDepositAmount)
            revert NotEnoughUnlockedCollateralToPredeposit(unlockedCollateral, totalDepositAmount);

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVaultOwnable.Deposit calldata _deposit = _deposits[i];

            if (validatorStatuses[_deposit.pubkey].bondStatus != BondStatus.NO_RECORD) {
                revert MustBeNewValidatorPubkey(_deposit.pubkey, validatorStatuses[_deposit.pubkey].bondStatus);
            }

            // cannot predeposit a validator with a deposit amount that is not 1 ether
            if (_deposit.amount != PREDEPOSIT_AMOUNT) revert PredepositDepositAmountInvalid(_deposit.pubkey, _deposit.amount);

            validatorStatuses[_deposit.pubkey] = ValidatorStatus({
                bondStatus: BondStatus.AWAITING_PROOF,
                stakingVault: _stakingVault,
                nodeOperator: _nodeOperator
            });
        }

        nodeOperatorBonds[_nodeOperator].locked += totalDepositAmount;
        _stakingVault.depositToBeaconChain(_deposits);

        emit ValidatorPreDeposited(_nodeOperator, address(_stakingVault), _deposits.length, totalDepositAmount);
    }

    function proveValidatorWC(ValidatorWitness calldata _witness) external {
        _processWCProof(_witness);
    }

    function depositToProvenValidators(
        IStakingVaultOwnable _stakingVault,
        IStakingVaultOwnable.Deposit[] calldata _deposits
    ) public {
        if (msg.sender != _stakingVault.nodeOperator()) {
            revert MustBeNodeOperator();
        }

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVaultOwnable.Deposit calldata _deposit = _deposits[i];

            if (validatorStatuses[_deposit.pubkey].bondStatus != BondStatus.PROVED) {
                revert DepositToUnprovenValidator(_deposit.pubkey, validatorStatuses[_deposit.pubkey].bondStatus);
            }

            if (validatorStatuses[_deposit.pubkey].stakingVault != _stakingVault) {
                revert DepositToWrongVault(_deposit.pubkey, address(_stakingVault));
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
        ValidatorWitness[] calldata _witnesses,
        IStakingVaultOwnable.Deposit[] calldata _deposits,
        IStakingVaultOwnable _stakingVault
    ) external payable {
        for (uint256 i = 0; i < _witnesses.length; i++) {
            _processWCProof(_witnesses[i]);
        }

        depositToProvenValidators(_stakingVault, _deposits);
    }

    // called by the staking vault owner if the predeposited validator was proven invalid
    // i.e. node operator was malicious and has stolen vault ether
    function withdrawDisprovenCollateral(bytes calldata validatorPubkey, address _recipient) external {
        ValidatorStatus storage validatorStatus = validatorStatuses[validatorPubkey];

        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        if (_recipient == address(validatorStatus.stakingVault)) revert WithdrawToVaultNotAllowed();

        if (msg.sender != validatorStatus.stakingVault.owner()) revert WithdrawSenderNotStakingVaultOwner();

        if (validatorStatus.bondStatus != BondStatus.PROVED_INVALID) revert ValidatorNotProvenInvalid(validatorStatus.bondStatus);

        validatorStatus.bondStatus = BondStatus.WITHDRAWN;

        (bool success, ) = _recipient.call{value: PREDEPOSIT_AMOUNT}("");

        if (!success) revert WithdrawalFailed();

        emit ValidatorDisprovenWithdrawn(validatorStatus.nodeOperator, validatorPubkey, address(validatorStatus.stakingVault), _recipient);
    }

    /// Internal functions

    function _validateNodeOperatorCaller(address _nodeOperator) internal view {
        if (nodeOperatorVoucher[_nodeOperator] == msg.sender) return;
        if (nodeOperatorVoucher[_nodeOperator] == address(0) && msg.sender == _nodeOperator) return;
        revert MustBeNodeOperatorOrVoucher();
    }

    function _topUpNodeOperatorCollateral(address _nodeOperator, uint256 _amount) internal {
        if (_amount == 0) revert ZeroArgument("msg.value");
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        _validateNodeOperatorCaller(_nodeOperator);

        nodeOperatorBonds[_nodeOperator].total += uint128(_amount);

        emit NodeOperatorBondToppedUp(_nodeOperator, _amount);
    }

    function _wcToAddress(bytes32 _withdrawalCredentials) internal pure returns (address) {
        return address(uint160(uint256(_withdrawalCredentials)));
    }

    function _deconstructWC(bytes32 _withdrawalCredentials) internal pure returns (uint64, address) {
        return (uint8(_withdrawalCredentials[0]), address(uint160(uint256(_withdrawalCredentials))));
    }

    function _processWCProof(ValidatorWitness calldata _witness) internal {
        ValidatorStatus storage validatorStatus = validatorStatuses[_witness.validator.pubkey];

        if (validatorStatus.bondStatus != BondStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited(_witness.validator.pubkey, validatorStatus.bondStatus);
        }

        (uint64 _wcVersion, address _wcAddress) = _deconstructWC(_witness.validator.withdrawalCredentials);

        if (_wcVersion < 1) {
            revert WithdrawalCredentialsAreInvalid(_witness.validator.pubkey);
        }

        _validateWCProof(_witness);

        // determine proof direction
        if (address(validatorStatus.stakingVault) == _wcAddress) {
            // stricter WC check to ensure WC version matches
            if (validatorStatus.stakingVault.withdrawalCredentials() != _witness.validator.withdrawalCredentials) {
                revert WithdrawalCredentialsAreInvalid(_witness.validator.pubkey);
            }

            validatorStatus.bondStatus = BondStatus.PROVED;

            emit ValidatorProven(validatorStatus.nodeOperator, _witness.validator.pubkey, address(validatorStatus.stakingVault), _witness.validator.withdrawalCredentials);
        } else {
            validatorStatus.bondStatus = BondStatus.PROVED_INVALID;
            nodeOperatorBonds[validatorStatus.nodeOperator].total -= PREDEPOSIT_AMOUNT;

            emit ValidatorDisproven(validatorStatus.nodeOperator, _witness.validator.pubkey, address(validatorStatus.stakingVault), _witness.validator.withdrawalCredentials);
        }
        nodeOperatorBonds[validatorStatus.nodeOperator].locked -= PREDEPOSIT_AMOUNT;
    }

    // node operator accounting
    error BondMustBeFullyUnlocked();
    error CannotSetSelfAsVoucher();

    // predeposit errors
    error PredepositNoDeposits();
    error PredepositDepositAmountInvalid(bytes validatorPubkey, uint256 depositAmount);
    error MustBeNewValidatorPubkey(bytes validatorPubkey, BondStatus bondStatus);
    error NotEnoughUnlockedCollateralToPredeposit(uint256 unlockedCollateral, uint256 totalDepositAmount);

    // depositing errors
    error DepositToUnprovenValidator(bytes validatorPubkey, BondStatus bondStatus);
    error DepositToWrongVault(bytes validatorPubkey, address stakingVault);
    error ValidatorNotPreDeposited(bytes validatorPubkey, BondStatus bondStatus);

    // prove
    error WithdrawalCredentialsAreInvalid(bytes validatorPubkey);
    // withdrawal proven
    error NotEnoughUnlockedCollateralToWithdraw(uint256 unlockedCollateral, uint256 amount);

    // withdrawal disproven
    error ValidatorNotProvenInvalid(BondStatus bondStatus);
    error WithdrawSenderNotStakingVaultOwner();
    /// withdrawal generic
    error WithdrawalFailed();
    error WithdrawToVaultNotAllowed();

    // auth
    error MustBeNodeOperatorOrVoucher();
    error MustBeNodeOperator();

    // general
    error ZeroArgument(string argument);
}
