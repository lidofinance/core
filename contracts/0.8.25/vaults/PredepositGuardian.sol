// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";

import {StakingVault} from "./StakingVault.sol";
import {IDepositContract} from "../interfaces/IDepositContract.sol";

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

    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    mapping(address nodeOperator => uint256) public nodeOperatorCollateral;
    mapping(address nodeOperator => uint256) public nodeOperatorCollateralLocked;
    mapping(address nodeOperator => address delegate) public nodeOperatorDelegate;

    mapping(bytes32 validatorPubkeyHash => ValidatorStatus validatorStatus) public validatorStatuses;
    mapping(bytes32 validatorPubkeyHash => bytes32 withdrawalCredentials) public validatorWithdrawalCredentials;
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

    // Question: predeposit is permissionless, i.e. the msg.sender doesn't have to be the node operator,
    // however, the deposit will still revert if it wasn't signed with the validator private key
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
            validatorWithdrawalCredentials[validatorId] = _stakingVault.withdrawalCredentials();
            validatorToNodeOperator[validatorId] = _nodeOperator;
        }

        nodeOperatorCollateralLocked[_nodeOperator] += totalDepositAmount;
        _stakingVault.depositToBeaconChain(_deposits);
        // TODO: event
    }

    function proveValidatorPreDeposit(
        StakingVault.Deposit calldata _deposit,
        bytes32[] calldata proof,
        uint64 beaconBlockTimestamp
    ) external {
        bytes32 validatorId = keccak256(_deposit.pubkey);
        // check that the validator is predeposited
        if (validatorStatuses[validatorId] != ValidatorStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited();
        }

        _validateDepositDataRoot(_deposit, validatorWithdrawalCredentials[validatorId]);

        // check that predeposit was made to the staking vault in proof
        _validateProof(proof, _deposit.depositDataRoot, beaconBlockTimestamp);

        nodeOperatorCollateralLocked[validatorToNodeOperator[validatorId]] -= PREDEPOSIT_AMOUNT;
        validatorStatuses[validatorId] = ValidatorStatus.PROVED;

        // TODO: event
    }

    function proveInvalidValidatorPreDeposit(
        StakingVault.Deposit calldata _deposit,
        bytes32 _invalidWC,
        bytes32[] calldata proof,
        uint64 beaconBlockTimestamp
    ) external {
        bytes32 validatorId = keccak256(_deposit.pubkey);

        // check that the validator is predeposited
        if (validatorStatuses[validatorId] != ValidatorStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited();
        }

        _validateDepositDataRoot(_deposit, _invalidWC);

        if (validatorWithdrawalCredentials[validatorId] == _invalidWC) {
            revert WithdrawalCredentialsAreValid();
        }

        _validateProof(proof, _deposit.depositDataRoot, beaconBlockTimestamp);

        validatorStatuses[validatorId] = ValidatorStatus.PROVED_INVALID;

        // TODO: event
    }

    function depositToProvenValidators(
        StakingVault _stakingVault,
        StakingVault.Deposit[] calldata _deposits
    ) external payable {
        _isValidNodeOperatorCaller(_stakingVault.nodeOperator());

        for (uint256 i = 0; i < _deposits.length; i++) {
            StakingVault.Deposit calldata _deposit = _deposits[i];
            bytes32 validatorId = keccak256(_deposit.pubkey);

            if (validatorStatuses[validatorId] != ValidatorStatus.PROVED) {
                revert DepositToUnprovenValidator();
            }

            if (validatorWithdrawalCredentials[validatorId] != _stakingVault.withdrawalCredentials()) {
                revert DepositToWrongVault();
            }
        }

        _stakingVault.depositToBeaconChain(_deposits);
    }

    // called by the staking vault owner if the predeposited validator has a different withdrawal credentials than the vault's withdrawal credentials,
    // i.e. node operator was malicious
    function withdrawDisprovenCollateral(
        StakingVault _stakingVault,
        bytes32 _validatorId,
        address _recipient
    ) external {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        address _nodeOperator = validatorToNodeOperator[_validatorId];
        if (validatorStatuses[_validatorId] != ValidatorStatus.PROVED_INVALID) revert ValidatorNotProvenInvalid();

        if (msg.sender != _stakingVault.owner()) revert WithdrawSenderNotStakingVaultOwner();

        if (_stakingVault.withdrawalCredentials() != validatorWithdrawalCredentials[_validatorId]) {
            revert WithdrawalCollateralOfWrongVault();
        }
        //if (_stakingVault.nodeOperator() != _nodeOperator) revert WithdrawSenderNotNodeOperator();

        nodeOperatorCollateralLocked[_nodeOperator] -= PREDEPOSIT_AMOUNT;
        nodeOperatorCollateral[_nodeOperator] -= PREDEPOSIT_AMOUNT;
        validatorStatuses[_validatorId] = ValidatorStatus.WITHDRAWN;

        (bool success, ) = _recipient.call{value: PREDEPOSIT_AMOUNT}("");
        if (!success) revert WithdrawalFailed();

        //TODO: events
    }

    /// Internal functions

    function _validateProof(
        bytes32[] calldata _proof,
        bytes32 _depositDataRoot,
        uint64 beaconBlockTimestamp
    ) internal view {
        if (!MerkleProof.verifyCalldata(_proof, _getParentBlockRoot(beaconBlockTimestamp), _depositDataRoot))
            revert InvalidProof();
    }

    function _topUpNodeOperatorCollateral(address _nodeOperator) internal {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");
        nodeOperatorCollateral[_nodeOperator] += msg.value;
        // TODO: event
    }

    function _isValidNodeOperatorCaller(address _nodeOperator) internal view {
        if (msg.sender != _nodeOperator && nodeOperatorDelegate[_nodeOperator] != msg.sender)
            revert MustBeNodeOperatorOrDelegate();
    }

    function _getParentBlockRoot(uint64 blockTimestamp) internal view returns (bytes32) {
        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(blockTimestamp));

        if (!success || data.length == 0) {
            revert RootNotFound();
        }

        return abi.decode(data, (bytes32));
    }

    function _validateDepositDataRoot(StakingVault.Deposit calldata _deposit, bytes32 _invalidWC) internal pure {
        bytes32 pubkey_root = sha256(abi.encodePacked(_deposit.pubkey, bytes16(0)));
        bytes32 signature_root = sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(_deposit.signature[:64])),
                sha256(abi.encodePacked(_deposit.signature[64:], bytes32(0)))
            )
        );
        bytes32 node = sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(pubkey_root, _invalidWC)),
                sha256(abi.encodePacked(_deposit.amount, bytes24(0), signature_root))
            )
        );

        if (_deposit.depositDataRoot != node) {
            revert InvalidDepositRoot();
        }
    }

    // predeposit errors
    error PredepositNoDeposits();
    error PredepositValueNotMultipleOfPrediposit();
    error PredepositDepositAmountInvalid();
    error MustBeNewValidatorPubkey();
    error NotEnoughUnlockedCollateralToPredeposit();

    // proving errors
    error ValidatorNotPreDeposited();
    error RootNotFound();
    error InvalidProof();
    error InvalidDepositRoot();

    // depositing errors
    error DepositToUnprovenValidator();
    error DepositToWrongVault();

    // withdrawal proven
    error NotEnoughUnlockedCollateralToWithdraw();

    // withdrawal disproven
    error ValidatorNotProvenInvalid();
    error WithdrawSenderNotStakingVaultOwner();
    error WithdrawSenderNotNodeOperator();
    error WithdrawValidatorDoesNotBelongToNodeOperator();
    error WithdrawalCollateralOfWrongVault();
    error WithdrawalCredentialsAreValid();
    /// withdrawal genereic
    error WithdrawalFailed();

    // auth
    error MustBeNodeOperatorOrDelegate();

    // general
    error ZeroArgument(string argument);
}
