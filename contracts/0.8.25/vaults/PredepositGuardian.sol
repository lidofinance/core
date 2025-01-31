// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {StakingVault} from "./StakingVault.sol";

// TODO: think about naming. It's not a deposit guardian, it's the depositor itself
// TODO: minor UX improvement: perhaps there's way to reuse predeposits for a different validator without withdrawing
contract PredepositGuardian {
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
    mapping(bytes32 validatorPubkeyHash => bytes32 withdrawalCredentials) public validatorWithdrawalCredentials;

    /// Events

    event NodeOperatorCollateralToppedUp(address indexed nodeOperator, uint256 amount);
    event NodeOperatorCollateralWithdrawn(address indexed nodeOperator, uint256 amount, address indexed recipient);
    event NodeOperatorDelegated(address indexed nodeOperator, address indexed delegate);
    event PredepositCompleted(address indexed nodeOperator, uint256 numberOfDeposits);
    event ValidatorProved(bytes32 indexed validatorPubkeyHash);
    event ValidatorProvedInvalid(bytes32 indexed validatorPubkeyHash);
    event ValidatorsDeposited(address indexed nodeOperator, uint256 numberOfDeposits);
    event ValidatorSlashed(bytes32 indexed validatorPubkeyHash, address indexed recipient);

    /// Views

    function nodeOperatorBalance(address nodeOperator) external view returns (uint256, uint256) {
        return (nodeOperatorCollateral[nodeOperator], nodeOperatorCollateralLocked[nodeOperator]);
    }

    function validatorInfo(bytes32 validatorPubkey) external view returns (ValidatorStatus, bytes32) {
        return (validatorStatuses[keccak256(validatorPubkey)], validatorWithdrawalCredentials[keccak256(validatorPubkey)]);
    }

    /// Balance operations

    function topUpNodeOperatorCollateral(address _nodeOperator) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        _topUpNodeOperatorCollateral(_nodeOperator);
    }

    function withdrawNodeOperatorCollateral(address _nodeOperator, uint256 _amount, address _recipient) external {
        if (_amount == 0) revert ZeroArgument("amount");
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        _isValidNodeOperatorCaller(_nodeOperator);

        uint256 unlockedCollateral = nodeOperatorCollateral[_nodeOperator] - nodeOperatorCollateralLocked[_nodeOperator];
        if (unlockedCollateral < _amount)
            revert NotEnoughUnlockedCollateralToWithdraw(unlockedCollateral, _amount);

        nodeOperatorCollateral[_nodeOperator] -= _amount;
        (bool success, ) = _recipient.call{value: _amount}("");

        if (!success) revert WithdrawalFailed();

        emit NodeOperatorCollateralWithdrawn(_nodeOperator, _amount, _recipient);
    }

    // delegation

    function delegateNodeOperator(address _delegate) external {
        nodeOperatorDelegate[msg.sender] = _delegate;
        emit NodeOperatorDelegated(msg.sender, _delegate);
    }

    // Question: predeposit is permissionless, i.e. the msg.sender doesn't have to be the node operator,
    // however, the deposit will still revert if it wasn't signed with the validator private key
    function predeposit(StakingVault _stakingVault, StakingVault.Deposit[] calldata _deposits) external payable {
        if (_deposits.length == 0) revert PredepositNoDeposits();

        address _nodeOperator = StakingVault(payable(_stakingVault)).nodeOperator();
        _isValidNodeOperatorCaller(_nodeOperator);

        // optional top up
        if (msg.value != 0) {
            _topUpNodeOperatorCollateral(_nodeOperator);
        }

        uint256 unlockedCollateral = nodeOperatorCollateral[_nodeOperator] -
            nodeOperatorCollateralLocked[_nodeOperator];

        uint256 totalDepositAmount = PREDEPOSIT_AMOUNT * _deposits.length;

        if (unlockedCollateral < totalDepositAmount) revert NotEnoughUnlockedCollateralToPredeposit(unlockedCollateral, totalDepositAmount);

        for (uint256 i = 0; i < _deposits.length; i++) {
            StakingVault.Deposit calldata _deposit = _deposits[i];

            bytes32 validatorId = keccak256(_deposit.pubkey);

            if (validatorStatuses[validatorId] != ValidatorStatus.NO_RECORD) {
                revert MustBeNewValidatorPubkey(validatorId, validatorStatuses[validatorId]);
            }

            // cannot predeposit a validator with a deposit amount that is not 1 ether
            if (_deposit.amount != PREDEPOSIT_AMOUNT) revert PredepositDepositAmountInvalid();

            validatorStatuses[validatorId] = ValidatorStatus.AWAITING_PROOF;
            // this prevents cross deposit to other vault
            validatorWithdrawalCredentials[validatorId] = _stakingVault.withdrawalCredentials();
        }

        nodeOperatorCollateralLocked[_nodeOperator] += totalDepositAmount;
        _stakingVault.depositToBeaconChain(_deposits);

        emit PredepositCompleted(_nodeOperator, _deposits.length);
    }

    function proveValidatorDeposit(
        StakingVault _stakingVault,
        bytes32[] calldata proof,
        StakingVault.Deposit calldata _deposit
    ) external {
        bytes32 validatorId = keccak256(_deposit.pubkey);

        // check that the validator is predeposited
        if (validatorStatuses[validatorId] != ValidatorStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited();
        }

        // check that predeposit was made to the staking vault in proof
        if (validatorWithdrawalCredentials[validatorId] != _stakingVault.withdrawalCredentials()) {
            revert InvalidStakingVault();
        }

        if (!_isValidProof(proof, _stakingVault.withdrawalCredentials(), _deposit)) revert InvalidProof(_deposit.pubkey);

        address _nodeOperator = _stakingVault.nodeOperator();
        nodeOperatorCollateralLocked[_nodeOperator] -= PREDEPOSIT_AMOUNT;

        validatorStatuses[validatorId] = ValidatorStatus.PROVED;

        emit ValidatorProved(validatorId);
    }

    function proveInvalidValidatorDeposit(
        bytes32[] calldata proof,
        StakingVault.Deposit calldata _deposit,
        bytes32 _invalidWC
    ) external {
        bytes32 validatorId = keccak256(_deposit.pubkey);

        // check that the validator is predeposited
        if (validatorStatuses[validatorId] != ValidatorStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited();
        }

        if (validatorWithdrawalCredentials[validatorId] == _invalidWC) {
            revert WithdrawalCredentialsAreValid();
        }

        if (!_isValidProof(proof, _invalidWC, _deposit)) revert InvalidProof(_deposit.pubkey);

        validatorStatuses[validatorId] = ValidatorStatus.PROVED_INVALID;

        emit ValidatorProvedInvalid(validatorId);
    }

    function depositToProvenValidators(
        StakingVault _stakingVault,
        StakingVault.Deposit[] calldata _deposits
    ) external payable {
        if (msg.sender != _stakingVault.nodeOperator()) revert DepositSenderNotNodeOperator();

        for (uint256 i = 0; i < _deposits.length; i++) {
            StakingVault.Deposit calldata deposit = _deposits[i];
            bytes32 validatorId = keccak256(deposit.pubkey);

            if (validatorStatuses[validatorId] != ValidatorStatus.PROVED || validatorWithdrawalCredentials[validatorId] != _stakingVault.withdrawalCredentials()) {
                revert DepositToUnprovenValidator();
            }
        }

        _stakingVault.depositToBeaconChain(_deposits);

        emit ValidatorsDeposited(_stakingVault.nodeOperator(), _deposits.length);
    }

    // called by the staking vault owner if the predeposited validator has a different withdrawal credentials than the vault's withdrawal credentials,
    // i.e. node operator was malicious
    function slashCollateral(StakingVault _stakingVault, bytes32 _validatorId, address _recipient) external {
        if (msg.sender != _stakingVault.owner()) revert WithdrawSenderNotStakingVaultOwner();
        if (_recipient == address(0)) revert WithdrawRecipientZeroAddress();

        if (validatorStatuses[_validatorId] != ValidatorStatus.PROVED_INVALID) {
            revert SlashingNotPermitted();
        }

        if (validatorWithdrawalCredentials[_validatorId] != _stakingVault.withdrawalCredentials()) {
            revert WithdrawValidatorWithdrawalCredentialsNotMatchingStakingVault();
        }

        if (nodeOperatorCollateralLocked[_stakingVault.nodeOperator()] < PREDEPOSIT_AMOUNT) {
            revert NotEnoughLockedCollateralToWithdraw(nodeOperatorCollateralLocked[_stakingVault.nodeOperator()], PREDEPOSIT_AMOUNT);
        }

        validatorStatuses[_validatorId] = ValidatorStatus.WITHDRAWN;
        nodeOperatorCollateral[_stakingVault.nodeOperator()] -= PREDEPOSIT_AMOUNT;
        nodeOperatorCollateralLocked[_stakingVault.nodeOperator()] -= PREDEPOSIT_AMOUNT;

        (bool success, ) = _recipient.call{value: PREDEPOSIT_AMOUNT}("");
        if (!success) revert WithdrawValidatorTransferFailed();

        emit ValidatorSlashed(_validatorId, _recipient);
    }

    /// Internal functions

    function _isValidProof(
        bytes32[] calldata _proof,
        bytes32 _withdrawalCredentials,
        StakingVault.Deposit calldata _deposit
    ) internal pure returns (bool) {
        // proof logic
        return true;
    }

    function _topUpNodeOperatorCollateral(address _nodeOperator) internal {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");
        nodeOperatorCollateral[_nodeOperator] += msg.value;

        emit NodeOperatorCollateralToppedUp(_nodeOperator, msg.value);
    }

    function _isValidNodeOperatorCaller(address _nodeOperator) internal view {
        if (msg.sender != _nodeOperator && nodeOperatorDelegate[_nodeOperator] != msg.sender)
            revert MustBeNodeOperatorOrDelegate();
    }

    error PredepositNoDeposits();
    error PredepositDepositAmountInvalid();
    error ValidatorNotPreDeposited();
    error DepositSenderNotNodeOperator();
    error DepositToUnprovenValidator();
    error WithdrawSenderNotStakingVaultOwner();
    error WithdrawRecipientZeroAddress();
    error WithdrawValidatorTransferFailed();
    error WithdrawValidatorWithdrawalCredentialsNotMatchingStakingVault();
    error MustBeNodeOperatorOrDelegate();
    error WithdrawalFailed();
    error InvalidStakingVault();
    error WithdrawalCredentialsAreValid();
    error SlashingNotPermitted();

    error NotEnoughUnlockedCollateralToWithdraw(uint256 unlockedCollateral, uint256 amount);
    error NotEnoughLockedCollateralToWithdraw(uint256 lockedCollateral, uint256 amount);
    error ZeroArgument(string argument);
    error NotEnoughUnlockedCollateralToPredeposit(uint256 unlockedCollateral, uint256 totalDepositAmount);
    error MustBeNewValidatorPubkey(bytes32 validatorId, ValidatorStatus validatorStatus);
    error InvalidProof(bytes32 validatorPubkey);

}
