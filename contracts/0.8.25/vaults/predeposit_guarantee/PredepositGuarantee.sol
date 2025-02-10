// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex} from "contracts/0.8.25/lib/GIndex.sol";
import {PausableUntilWithRoles} from "contracts/0.8.25/utils/PausableUntilWithRoles.sol";

import {CLProofVerifier} from "./CLProofVerifier.sol";

import {IStakingVaultOwnable} from "../interfaces/IStakingVault.sol";

/**
 * @title PredepositGuarantee
 * @author Lido
 * @notice
 */
contract PredepositGuarantee is CLProofVerifier, PausableUntilWithRoles {
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

    /**
     * @notice ERC-7201 storage namespace for the vault
     * @dev ERC-7201 namespace is used to prevent upgrade collisions
     * @custom: TODO
     */
    struct ERC7201Storage {
        mapping(address nodeOperator => NodeOperatorBond bond) nodeOperatorBonds;
        mapping(address nodeOperator => address voucher) nodeOperatorVouchers;
        mapping(bytes validatorPubkey => ValidatorStatus validatorStatus) validatorStatuses;
    }

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         `keccak256(abi.encode(uint256(keccak256("Lido.Vaults.PredepositGuarantee")) - 1)) & ~bytes32(uint256(0xff))`
     */
    bytes32 private constant ERC721_STORAGE_LOCATION =
        0xf66b5a365356c5798cc70e3ea6a236b181a826a69f730fc07cc548244bee5200;

    constructor(GIndex _gIFirstValidator) CLProofVerifier(_gIFirstValidator) {
        _disableInitializers();
    }

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __AccessControlEnumerable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // * * * * * * * * * * * * * * * * * * * * //
    // * * * Node Operator Balance Logic * * * //
    // * * * * * * * * * * * * * * * * * * * * //

    function nodeOperatorBond(address _nodeOperator) external view returns (NodeOperatorBond memory) {
        return _getStorage().nodeOperatorBonds[_nodeOperator];
    }

    function nodeOperatorVoucher(address _nodeOperator) external view returns (address) {
        return _getStorage().nodeOperatorVouchers[_nodeOperator];
    }

    function validatorStatus(bytes calldata _validatorPubkey) external view returns (ValidatorStatus memory) {
        return _getStorage().validatorStatuses[_validatorPubkey];
    }

    /// NO Balance operations

    function topUpNodeOperatorBond(address _nodeOperator) external payable {
        _topUpNodeOperatorBalance(_nodeOperator);
    }

    function withdrawNodeOperatorBond(address _nodeOperator, uint128 _amount, address _recipient) external {
        if (_amount == 0) revert ZeroArgument("amount");
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        ERC7201Storage storage $ = _getStorage();

        _validateNodeOperatorCaller(_nodeOperator);

        uint256 unlocked = $.nodeOperatorBonds[_nodeOperator].total - $.nodeOperatorBonds[_nodeOperator].locked;

        if (unlocked < _amount) revert NotEnoughUnlockedBondToWithdraw(unlocked, _amount);

        $.nodeOperatorBonds[_nodeOperator].total -= _amount;
        (bool success, ) = _recipient.call{value: uint256(_amount)}("");
        if (!success) revert WithdrawalFailed();

        emit NodeOperatorBondWithdrawn(_nodeOperator, _amount, _recipient);
    }

    function setNodeOperatorVoucher(address _voucher) external payable {
        ERC7201Storage storage $ = _getStorage();

        NodeOperatorBond storage bond = $.nodeOperatorBonds[msg.sender];

        if (_voucher == msg.sender) revert CannotSetSelfAsVoucher();

        if (bond.locked != 0) revert BondMustBeFullyUnlocked(bond.locked);

        if (bond.total > 0 && $.nodeOperatorVouchers[msg.sender] != address(0)) {
            uint256 _ejected = $.nodeOperatorBonds[msg.sender].total;
            $.nodeOperatorBonds[msg.sender].total = 0;
            (bool success, ) = $.nodeOperatorVouchers[msg.sender].call{value: _ejected}("");

            // voucher can block change?
            if (!success) revert WithdrawalFailed();

            emit NodeOperatorBondWithdrawn(msg.sender, _ejected, _voucher);
        }

        // optional top up that will only work in NO sets voucher to zero address
        if (msg.value != 0) {
            _topUpNodeOperatorBalance(msg.sender);
        }

        $.nodeOperatorVouchers[msg.sender] = _voucher;

        emit NodeOperatorVoucherSet(msg.sender, _voucher);
    }

    // * * * * * * * * * * * * * * * * * * * * //
    // * * * * * Deposit Operations  * * * * * //
    // * * * * * * * * * * * * * * * * * * * * //

    function predeposit(
        IStakingVaultOwnable _stakingVault,
        IStakingVaultOwnable.Deposit[] calldata _deposits
    ) external payable {
        if (_deposits.length == 0) revert PredepositNoDeposits();

        address _nodeOperator = _stakingVault.nodeOperator();
        if (msg.sender != _nodeOperator) revert MustBeNodeOperator();

        // optional top up
        if (msg.value != 0) {
            _topUpNodeOperatorBalance(_nodeOperator);
        }

        // ensures vault fair play
        if (address(_stakingVault) != _wcToAddress(_stakingVault.withdrawalCredentials())) {
            revert StakingVaultWithdrawalCredentialsMismatch(
                address(_stakingVault),
                _wcToAddress(_stakingVault.withdrawalCredentials())
            );
        }

        ERC7201Storage storage $ = _getStorage();

        uint128 totalDepositAmount = PREDEPOSIT_AMOUNT * uint128(_deposits.length);
        uint256 unlocked = $.nodeOperatorBonds[_nodeOperator].total - $.nodeOperatorBonds[_nodeOperator].locked;

        if (unlocked < totalDepositAmount)
            revert NotEnoughUnlockedUnlockedBondToPredeposit(unlocked, totalDepositAmount);

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVaultOwnable.Deposit calldata _deposit = _deposits[i];

            if ($.validatorStatuses[_deposit.pubkey].bondStatus != BondStatus.NO_RECORD) {
                revert MustBeNewValidatorPubkey(_deposit.pubkey, $.validatorStatuses[_deposit.pubkey].bondStatus);
            }

            // cannot predeposit a validator with a deposit amount that is not 1 ether
            if (_deposit.amount != PREDEPOSIT_AMOUNT)
                revert PredepositDepositAmountInvalid(_deposit.pubkey, _deposit.amount);

            $.validatorStatuses[_deposit.pubkey] = ValidatorStatus({
                bondStatus: BondStatus.AWAITING_PROOF,
                stakingVault: _stakingVault,
                nodeOperator: _nodeOperator
            });
        }

        $.nodeOperatorBonds[_nodeOperator].locked += totalDepositAmount;
        _stakingVault.depositToBeaconChain(_deposits);

        emit ValidatorPreDeposited(_nodeOperator, address(_stakingVault), _deposits.length);
    }

    // * * * * * Positive Proof Flow  * * * * * //

    function proveValidatorWC(ValidatorWitness calldata _witness) external {
        _processWCProof(_witness);
    }

    function depositToBeaconChain(
        IStakingVaultOwnable _stakingVault,
        IStakingVaultOwnable.Deposit[] calldata _deposits
    ) public payable {
        if (msg.sender != _stakingVault.nodeOperator()) {
            revert MustBeNodeOperator();
        }

        if (msg.value != 0) {
            _topUpNodeOperatorBalance(_stakingVault.nodeOperator());
        }

        ERC7201Storage storage $ = _getStorage();

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVaultOwnable.Deposit calldata _deposit = _deposits[i];

            if ($.validatorStatuses[_deposit.pubkey].bondStatus != BondStatus.PROVED) {
                revert DepositToUnprovenValidator(_deposit.pubkey, $.validatorStatuses[_deposit.pubkey].bondStatus);
            }

            if ($.validatorStatuses[_deposit.pubkey].stakingVault != _stakingVault) {
                revert DepositToWrongVault(_deposit.pubkey, address(_stakingVault));
            }
        }

        _stakingVault.depositToBeaconChain(_deposits);
    }

    /**
     @notice happy path shortcut for the node operator that allows:
      - prove validators to free up bond
      - optionally top up NO bond
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

        depositToBeaconChain(_stakingVault, _deposits);
    }

    // * * * * * Negative Proof Flow  * * * * * //

    function proveInvalidValidatorWC(ValidatorWitness calldata _witness, bytes32 _invalidWithdrawalCredentials) public {
        ERC7201Storage storage $ = _getStorage();

        ValidatorStatus storage validator = $.validatorStatuses[_witness.pubkey];

        if (validator.bondStatus != BondStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited(_witness.pubkey, validator.bondStatus);
        }

        if (address(validator.stakingVault) == _wcToAddress(_invalidWithdrawalCredentials)) {
            revert WithdrawalCredentialsAreValid();
        }

        _validatePubKeyWCProof(_witness, _invalidWithdrawalCredentials);

        // reduces total&locked NO deposit
        $.nodeOperatorBonds[validator.nodeOperator].total -= PREDEPOSIT_AMOUNT;
        $.nodeOperatorBonds[validator.nodeOperator].locked -= PREDEPOSIT_AMOUNT;
        // freed ether only will returned to owner of the vault with this validator
        validator.bondStatus = BondStatus.PROVED_INVALID;

        emit ValidatorDisproven(
            validator.nodeOperator,
            _witness.pubkey,
            address(validator.stakingVault),
            _invalidWithdrawalCredentials
        );
    }

    // called by the staking vault owner if the predeposited validator was proven invalid
    // i.e. node operator was malicious and has stolen vault ether
    function withdrawDisprovenPredeposit(bytes calldata validatorPubkey, address _recipient) public {
        ValidatorStatus storage validator = _getStorage().validatorStatuses[validatorPubkey];

        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        if (_recipient == address(validator.stakingVault)) revert WithdrawToVaultNotAllowed();

        if (msg.sender != validator.stakingVault.owner()) revert WithdrawSenderNotStakingVaultOwner();

        if (validator.bondStatus != BondStatus.PROVED_INVALID) revert ValidatorNotProvenInvalid(validator.bondStatus);

        validator.bondStatus = BondStatus.WITHDRAWN;

        (bool success, ) = _recipient.call{value: PREDEPOSIT_AMOUNT}("");

        if (!success) revert WithdrawalFailed();

        emit ValidatorDisprovenWithdrawn(
            validator.nodeOperator,
            validatorPubkey,
            address(validator.stakingVault),
            _recipient
        );
    }

    function disproveAndWithdraw(
        ValidatorWitness calldata _witness,
        bytes32 _invalidWithdrawalCredentials,
        address _recipient
    ) external {
        proveInvalidValidatorWC(_witness, _invalidWithdrawalCredentials);
        withdrawDisprovenPredeposit(_witness.pubkey, _recipient);
    }

    /// Internal functions

    function _topUpNodeOperatorBalance(address _nodeOperator) internal {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        _validateNodeOperatorCaller(_nodeOperator);

        _getStorage().nodeOperatorBonds[_nodeOperator].total += uint128(msg.value);

        emit NodeOperatorBondToppedUp(_nodeOperator, msg.value);
    }

    function _validateNodeOperatorCaller(address _nodeOperator) internal view {
        ERC7201Storage storage $ = _getStorage();
        if ($.nodeOperatorVouchers[_nodeOperator] == msg.sender) return;
        if ($.nodeOperatorVouchers[_nodeOperator] == address(0) && msg.sender == _nodeOperator) return;
        revert MustBeNodeOperatorOrVoucher();
    }

    function _wcToAddress(bytes32 _withdrawalCredentials) internal pure returns (address _wcAddress) {
        uint64 _wcVersion = uint8(_withdrawalCredentials[0]);

        if (_wcVersion < 1) {
            revert WithdrawalCredentialsInvalidVersion(_wcVersion);
        }

        _wcAddress = address(uint160(uint256(_withdrawalCredentials)));
    }

    function _processWCProof(ValidatorWitness calldata _witness) internal {
        ValidatorStatus storage validator = _getStorage().validatorStatuses[_witness.pubkey];

        if (validator.bondStatus != BondStatus.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited(_witness.pubkey, validator.bondStatus);
        }

        bytes32 _withdrawalCredentials = validator.stakingVault.withdrawalCredentials();

        // ensures vault fair play
        if (address(validator.stakingVault) != _wcToAddress(_withdrawalCredentials)) {
            revert StakingVaultWithdrawalCredentialsMismatch(
                address(validator.stakingVault),
                _wcToAddress(_withdrawalCredentials)
            );
        }

        _validatePubKeyWCProof(_witness, _withdrawalCredentials);

        validator.bondStatus = BondStatus.PROVED;
        _getStorage().nodeOperatorBonds[validator.nodeOperator].locked -= PREDEPOSIT_AMOUNT;

        emit ValidatorProven(
            validator.nodeOperator,
            _witness.pubkey,
            address(validator.stakingVault),
            _withdrawalCredentials
        );
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC721_STORAGE_LOCATION
        }
    }

    // * * * * * Events  * * * * * //

    event NodeOperatorBondToppedUp(address indexed nodeOperator, uint256 amount);
    event NodeOperatorBondWithdrawn(address indexed nodeOperator, uint256 amount, address indexed recipient);
    event NodeOperatorVoucherSet(address indexed nodeOperator, address indexed voucher);
    event ValidatorPreDeposited(address indexed nodeOperator, address indexed stakingVault, uint256 numberOfDeposits);
    event ValidatorProven(
        address indexed nodeOperator,
        bytes indexed validatorPubkey,
        address indexed stakingVault,
        bytes32 withdrawalCredentials
    );
    event ValidatorDisproven(
        address indexed nodeOperator,
        bytes indexed validatorPubkey,
        address indexed stakingVault,
        bytes32 withdrawalCredentials
    );
    event ValidatorDisprovenWithdrawn(
        address indexed nodeOperator,
        bytes indexed validatorPubkey,
        address indexed stakingVault,
        address recipient
    );

    // * * * * * Errors  * * * * * //

    // node operator accounting
    error BondMustBeFullyUnlocked(uint256 locked);
    error CannotSetSelfAsVoucher();

    // predeposit errors
    error PredepositNoDeposits();
    error PredepositDepositAmountInvalid(bytes validatorPubkey, uint256 depositAmount);
    error MustBeNewValidatorPubkey(bytes validatorPubkey, BondStatus bondStatus);
    error NotEnoughUnlockedUnlockedBondToPredeposit(uint256 unlocked, uint256 totalDepositAmount);
    error StakingVaultWithdrawalCredentialsMismatch(address stakingVault, address withdrawalCredentialsAddress);

    // depositing errors
    error DepositToUnprovenValidator(bytes validatorPubkey, BondStatus bondStatus);
    error DepositToWrongVault(bytes validatorPubkey, address stakingVault);
    error ValidatorNotPreDeposited(bytes validatorPubkey, BondStatus bondStatus);

    // prove
    error WithdrawalCredentialsAreInvalid();
    error WithdrawalCredentialsAreValid();
    error WithdrawalCredentialsInvalidVersion(uint64 version);
    // withdrawal proven
    error NotEnoughUnlockedBondToWithdraw(uint256 unlocked, uint256 amount);

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
