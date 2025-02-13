// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex} from "contracts/0.8.25/lib/GIndex.sol";
import {BeaconBlockHeader} from "contracts/0.8.25/lib/SSZ.sol";
import {PausableUntilWithRoles} from "contracts/0.8.25/utils/PausableUntilWithRoles.sol";

import {CLProofVerifier} from "./CLProofVerifier.sol";

import {IStakingVaultOwnable} from "../interfaces/IStakingVault.sol";

/**
 * @title PredepositGuarantee
 * @author Lido
 * @notice This contract acts as permissionless deposit security layer for all compatible staking vaults.
 *         It allows Node Operators(NO) to provide ether to back up their validators' deposits.
 *         While only Staking Vault ether is used to deposit to the beacon chain, NO's ether is locked.
 *         And can only be unlocked if the validator is proven to have valid Withdrawal Credentials on Ethereum Consensus Layer.
 *         Merkle proofs against Beacon Block Root are used to prove both validator's validity and invalidity
 *         where invalid validators's ether can be withdrawn by the staking vault owner.
 *         A system of NO's guarantors can be used to allow NOs to handle deposits and verifications
 *         while guarantors provide ether.
 *
 *     !NB:
 *         There is a mutual trust assumption between NO's and guarantors.
 *         Internal guards for NO<->Guarantor are used only to prevent mistakes and provide recovery in OP-SEC incidents.
 *         But can not be used to fully prevent malicious behavior in this relationship where NO's can access guarantor provided ether.
 *
 *
 *     !NB:
 *         PDG is permissionless by design. Anyone can be an NO, provided there is a compatible staking vault
 *         that has `nodeOperator()` as NO and allows PDG to perform `depositToBeaconChain()` on it
 *         Staking Vault does not have to be connected to Lido or any other system to be compatible with PDG
 *         but a reverse constraint can be AND are applied.
 */
contract PredepositGuarantee is CLProofVerifier, PausableUntilWithRoles {
    /**
     * @notice represents validator stages in PDG flow
     * @dev if validator is in PROVED_INVALID and it's PREDEPOSIT_AMOUNT is withdrawn
     *      it's deleted from the storage and status returns to NONE to free up storage/gas
     * @param NONE  - initial stage
     * @param AWAITING_PROOF - PREDEPOSIT_AMOUNT is deposited with this validator by the vault
     * @param PROVEN - validator is proven to be valid and can be used to deposit to beacon chain
     * @param PROVEN_INVALID - validator is proven to be invalid and it's PREDEPOSIT_AMOUNT can be withdrawn by staking vault owner
     */
    enum validatorStage {
        NONE,
        AWAITING_PROOF,
        PROVEN,
        PROVEN_INVALID
    }
    /**
     * @notice represents NO balance in PDG
     * @dev fits into single 32 bytes slot
     * @param total total ether balance of the NO
     * @param locked ether locked in unproved predeposits
     */
    struct NodeOperatorBalance {
        uint128 total;
        uint128 locked;
    }
    /**
     * @notice represents status of the validator in PDG
     * @dev is used to track validator from predeposit -> proof -> deposit
     * @param stage represents validator stage in PDG flow
     * @param stakingVault hard links validator to specific StakingVault to prevent cross-deposit
     * @param nodeOperator hard links validator to specific NO to prevent malicious vault-mimic for stealing balance
     */
    struct ValidatorStatus {
        validatorStage stage;
        IStakingVaultOwnable stakingVault;
        address nodeOperator;
    }

    /**
     * @notice ERC-7201 storage namespace for the vault
     * @dev ERC-7201 namespace is used to prevent upgrade collisions
     * @param nodeOperatorBalance - balance of NO in PDG
     * @param nodeOperatorGuarantor - mapping of NO to guarantor, where zero address means NO is self-guarantor
     * @param guarantorClaimableEther - ether that guarantor can claim back if NO has changed guarantor with balance
     * @param validatorStatus - status of the validators in PDG
     */
    struct ERC7201Storage {
        mapping(address nodeOperator => NodeOperatorBalance balance) nodeOperatorBalance;
        mapping(address nodeOperator => address guarantor) nodeOperatorGuarantor;
        mapping(address guarantor => uint256 claimableEther) guarantorClaimableEther;
        mapping(bytes validatorPubkey => ValidatorStatus validatorStatus) validatorStatus;
    }

    uint128 public constant PREDEPOSIT_AMOUNT = 1 ether;

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         keccak256(abi.encode(uint256(keccak256("Lido.Vaults.PredepositGuarantee")) - 1)) & ~bytes32(uint256(0xff))
     */
    bytes32 private constant ERC7201_STORAGE_LOCATION =
        0xf66b5a365356c5798cc70e3ea6a236b181a826a69f730fc07cc548244bee5200;

    constructor(
        GIndex _gIFirstValidator,
        GIndex _gIFirstValidatorAfterChange,
        uint64 _changeSlot
    ) CLProofVerifier(_gIFirstValidator, _gIFirstValidatorAfterChange, _changeSlot) {
        _disableInitializers();
    }

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __AccessControlEnumerable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // * * * * * * * * * * * * * * * * * * * * //
    // * * * Node Operator Accounting Logic * * * //
    // * * * * * * * * * * * * * * * * * * * * //

    function nodeOperatorBalance(address _nodeOperator) external view returns (NodeOperatorBalance memory) {
        return _getStorage().nodeOperatorBalance[_nodeOperator];
    }

    function nodeOperatorGuarantor(address _nodeOperator) external view returns (address) {
        return _getStorage().nodeOperatorGuarantor[_nodeOperator];
    }

    function validatorStatus(bytes calldata _validatorPubkey) external view returns (ValidatorStatus memory) {
        return _getStorage().validatorStatus[_validatorPubkey];
    }

    function topUpNodeOperatorBalance(address _nodeOperator) external payable whenResumed {
        _topUpNodeOperatorBalance(_nodeOperator);
    }

    function withdrawNodeOperatorBalance(
        address _nodeOperator,
        uint128 _amount,
        address _recipient
    ) external onlyNodeOperatorOrGuarantor(_nodeOperator) whenResumed {
        if (_amount == 0) revert ZeroArgument("amount");
        if (_amount % PREDEPOSIT_AMOUNT != 0) revert ValueMustBeMultipleOfPredepositAmount(_amount);
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        ERC7201Storage storage $ = _getStorage();

        uint256 unlocked = $.nodeOperatorBalance[_nodeOperator].total - $.nodeOperatorBalance[_nodeOperator].locked;

        if (unlocked < _amount) revert NotEnoughUnlockedBondToWithdraw(unlocked, _amount);

        $.nodeOperatorBalance[_nodeOperator].total -= _amount;
        (bool success, ) = _recipient.call{value: uint256(_amount)}("");
        if (!success) revert WithdrawalFailed();

        emit NodeOperatorBalanceWithdrawn(_nodeOperator, _recipient, _amount);
    }

    /**
     * @notice changes guarantor for the NO and provides refund to guarantor if NO has balance
     * @param _newGuarantor address of the new guarantor, zero address to make NO self-guarantor
     * @dev refunded ether can be claimed by guarantor with `claimGuarantorRefund()`
     */
    function setNodeOperatorGuarantor(address _newGuarantor) external whenResumed {
        ERC7201Storage storage $ = _getStorage();

        NodeOperatorBalance storage balance = $.nodeOperatorBalance[msg.sender];

        if (_newGuarantor == msg.sender) revert CannotSetSelfAsGuarantor();

        if (balance.locked != 0) revert BondMustBeFullyUnlocked(balance.locked);

        if (balance.total > 0 && $.nodeOperatorGuarantor[msg.sender] != address(0)) {
            uint256 refund = $.nodeOperatorBalance[msg.sender].total;
            $.nodeOperatorBalance[msg.sender].total = 0;
            $.guarantorClaimableEther[$.nodeOperatorGuarantor[msg.sender]] += refund;

            emit GuarantorRefunded(_newGuarantor, msg.sender, refund);
        }

        $.nodeOperatorGuarantor[msg.sender] = _newGuarantor;

        emit NodeOperatorGuarantorSet(msg.sender, _newGuarantor);
    }

    function claimGuarantorRefund(address _recipient) external returns (uint256) {
        ERC7201Storage storage $ = _getStorage();

        uint256 claimableEther = $.guarantorClaimableEther[msg.sender];

        if (claimableEther == 0) revert EmptyRefund();

        $.guarantorClaimableEther[msg.sender] = 0;

        (bool success, ) = _recipient.call{value: claimableEther}("");

        if (!success) revert RefundFailed();

        emit GuarantorRefundClaimed(msg.sender, _recipient, claimableEther);

        return claimableEther;
    }

    // * * * * * * * * * * * * * * * * * * * * //
    // * * * * * Deposit Operations  * * * * * //
    // * * * * * * * * * * * * * * * * * * * * //

    /**
     * @notice deposits NO's validators with PREDEPOSIT_AMOUNT ether from StakingVault and locks up NO's balance
     * @dev if NO has no guarantor, accepts multiples of`PREDEPOSIT_AMOUNT` in msg.value to top up NO balance
     * @param _stakingVault to deposit validators to
     * @param _deposits StakingVault deposit struct that has amount as PREDEPOSIT_AMOUNT
     */
    function predeposit(
        IStakingVaultOwnable _stakingVault,
        IStakingVaultOwnable.Deposit[] calldata _deposits
    ) external payable whenResumed {
        if (_deposits.length == 0) revert PredepositNoDeposits();

        address _nodeOperator = _stakingVault.nodeOperator();
        if (msg.sender != _nodeOperator) revert MustBeNodeOperator();

        // check that node operator can top up themselves is inside
        if (msg.value != 0) {
            _topUpNodeOperatorBalance(_nodeOperator);
        }

        // sanity check that vault returns correct WC
        if (address(_stakingVault) != _wcToAddress(_stakingVault.withdrawalCredentials())) {
            revert StakingVaultWithdrawalCredentialsMismatch(
                address(_stakingVault),
                _wcToAddress(_stakingVault.withdrawalCredentials())
            );
        }

        ERC7201Storage storage $ = _getStorage();

        uint128 totalDepositAmount = PREDEPOSIT_AMOUNT * uint128(_deposits.length);
        uint128 unlocked = $.nodeOperatorBalance[_nodeOperator].total - $.nodeOperatorBalance[_nodeOperator].locked;

        if (unlocked < totalDepositAmount) revert NotEnoughUnlockedBondToPredeposit(unlocked, totalDepositAmount);

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVaultOwnable.Deposit calldata _deposit = _deposits[i];

            if ($.validatorStatus[_deposit.pubkey].stage != validatorStage.NONE) {
                revert MustBeNewValidatorPubkey(_deposit.pubkey, $.validatorStatus[_deposit.pubkey].stage);
            }

            // cannot predeposit a validator with a deposit amount that is not 1 ether
            if (_deposit.amount != PREDEPOSIT_AMOUNT)
                revert PredepositDepositAmountInvalid(_deposit.pubkey, _deposit.amount);

            $.validatorStatus[_deposit.pubkey] = ValidatorStatus({
                stage: validatorStage.AWAITING_PROOF,
                stakingVault: _stakingVault,
                nodeOperator: _nodeOperator
            });
        }

        $.nodeOperatorBalance[_nodeOperator].locked += totalDepositAmount;
        _stakingVault.depositToBeaconChain(_deposits);

        emit ValidatorsPreDeposited(_nodeOperator, address(_stakingVault), _deposits.length);
    }

    // * * * * * Positive Proof Flow  * * * * * //

    function proveValidatorWC(ValidatorWitness calldata _witness) public whenResumed {
        bytes32 withdrawalCredentials = _getStorage()
            .validatorStatus[_witness.pubkey]
            .stakingVault
            .withdrawalCredentials();

        _validatePubKeyWCProof(_witness, withdrawalCredentials);

        _processPositiveProof(_witness.pubkey, withdrawalCredentials);
    }

    function proveValidatorWCWithBeaconHeader(
        ValidatorWitness calldata _witness,
        BeaconBlockHeader calldata _header
    ) public whenResumed {
        bytes32 withdrawalCredentials = _getStorage()
            .validatorStatus[_witness.pubkey]
            .stakingVault
            .withdrawalCredentials();

        proveSlotChange(_header, _witness.childBlockTimestamp);

        _processPositiveProof(_witness.pubkey, withdrawalCredentials);
    }

    function depositToBeaconChain(
        IStakingVaultOwnable _stakingVault,
        IStakingVaultOwnable.Deposit[] calldata _deposits
    ) public payable whenResumed {
        if (msg.sender != _stakingVault.nodeOperator()) {
            revert MustBeNodeOperator();
        }

        ERC7201Storage storage $ = _getStorage();

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVaultOwnable.Deposit calldata _deposit = _deposits[i];

            if ($.validatorStatus[_deposit.pubkey].stage != validatorStage.PROVEN) {
                revert DepositToUnprovenValidator(_deposit.pubkey, $.validatorStatus[_deposit.pubkey].stage);
            }

            if ($.validatorStatus[_deposit.pubkey].stakingVault != _stakingVault) {
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
            proveValidatorWC(_witnesses[i]);
        }

        depositToBeaconChain(_stakingVault, _deposits);
    }

    // * * * * * Negative Proof Flow  * * * * * //

    function proveInvalidValidatorWC(
        ValidatorWitness calldata _witness,
        bytes32 _invalidWithdrawalCredentials
    ) public whenResumed {
        _validatePubKeyWCProof(_witness, _invalidWithdrawalCredentials);

        _processNegativeProof(_witness.pubkey, _invalidWithdrawalCredentials);
    }

    function proveInvalidValidatorWCWithBeaconHeader(
        ValidatorWitness calldata _witness,
        BeaconBlockHeader calldata _header,
        bytes32 _invalidWithdrawalCredentials
    ) public whenResumed {
        proveSlotChange(_header, _witness.childBlockTimestamp);
        _validatePubKeyWCProof(_witness, _invalidWithdrawalCredentials);

        _processNegativeProof(_witness.pubkey, _invalidWithdrawalCredentials);
    }

    // called by the staking vault owner if the predeposited validator was proven invalid
    // i.e. node operator was malicious and has stolen vault ether
    function withdrawDisprovenPredeposit(
        bytes calldata _validatorPubkey,
        address _recipient
    ) public whenResumed returns (uint128) {
        ValidatorStatus storage validator = _getStorage().validatorStatus[_validatorPubkey];

        IStakingVaultOwnable _stakingVault = validator.stakingVault;
        address _nodeOperator = validator.nodeOperator;

        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        if (_recipient == address(_stakingVault)) revert WithdrawToVaultNotAllowed();

        if (msg.sender != _stakingVault.owner()) revert WithdrawSenderNotStakingVaultOwner();

        if (validator.stage != validatorStage.PROVEN_INVALID) revert ValidatorNotProvenInvalid(validator.stage);

        delete _getStorage().validatorStatus[_validatorPubkey];

        (bool success, ) = _recipient.call{value: PREDEPOSIT_AMOUNT}("");

        if (!success) revert WithdrawalFailed();

        emit ValidatorDisprovenWithdrawn(_nodeOperator, _validatorPubkey, address(_stakingVault), _recipient);

        return PREDEPOSIT_AMOUNT;
    }

    function disproveAndWithdraw(
        ValidatorWitness calldata _witness,
        bytes32 _invalidWithdrawalCredentials,
        address _recipient
    ) external returns (uint128) {
        proveInvalidValidatorWC(_witness, _invalidWithdrawalCredentials);
        return withdrawDisprovenPredeposit(_witness.pubkey, _recipient);
    }

    /// Internal functions

    function _processPositiveProof(bytes calldata _pubkey, bytes32 _withdrawalCredentials) internal {
        ERC7201Storage storage $ = _getStorage();
        ValidatorStatus storage _validator = $.validatorStatus[_pubkey];

        if (_validator.stage != validatorStage.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited(_pubkey, _validator.stage);
        }

        // sanity check that vault returns correct WC
        if (address(_validator.stakingVault) != _wcToAddress(_withdrawalCredentials)) {
            revert StakingVaultWithdrawalCredentialsMismatch(
                address(_validator.stakingVault),
                _wcToAddress(_withdrawalCredentials)
            );
        }

        _validator.stage = validatorStage.PROVEN;
        $.nodeOperatorBalance[_validator.nodeOperator].locked -= PREDEPOSIT_AMOUNT;

        emit ValidatorProven(
            _validator.nodeOperator,
            _pubkey,
            address(_validator.stakingVault),
            _withdrawalCredentials
        );
    }

    function _processNegativeProof(bytes calldata _pubkey, bytes32 _invalidWithdrawalCredentials) internal {
        ERC7201Storage storage $ = _getStorage();
        ValidatorStatus storage validator = $.validatorStatus[_pubkey];

        if (validator.stage != validatorStage.AWAITING_PROOF) {
            revert ValidatorNotPreDeposited(_pubkey, validator.stage);
        }

        uint64 wcVersion = uint8(_invalidWithdrawalCredentials[0]);
        // 0x00 WC are invalid by default
        if (wcVersion != 0 && address(validator.stakingVault) == _wcToAddress(_invalidWithdrawalCredentials)) {
            revert WithdrawalCredentialsAreValid();
        }

        // reduces total&locked NO deposit
        $.nodeOperatorBalance[validator.nodeOperator].total -= PREDEPOSIT_AMOUNT;
        $.nodeOperatorBalance[validator.nodeOperator].locked -= PREDEPOSIT_AMOUNT;
        // freed ether only will returned to owner of the vault with this validator
        validator.stage = validatorStage.PROVEN_INVALID;

        emit ValidatorDisproven(
            validator.nodeOperator,
            _pubkey,
            address(validator.stakingVault),
            _invalidWithdrawalCredentials
        );
    }

    function _topUpNodeOperatorBalance(address _nodeOperator) internal onlyNodeOperatorOrGuarantor(_nodeOperator) {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (msg.value % PREDEPOSIT_AMOUNT != 0) revert ValueMustBeMultipleOfPredepositAmount(msg.value);
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        _getStorage().nodeOperatorBalance[_nodeOperator].total += uint128(msg.value);

        emit NodeOperatorBalanceToppedUp(_nodeOperator, msg.sender, msg.value);
    }

    modifier onlyNodeOperatorOrGuarantor(address _nodeOperator) {
        ERC7201Storage storage $ = _getStorage();
        if (
            !($.nodeOperatorGuarantor[_nodeOperator] == msg.sender ||
                ($.nodeOperatorGuarantor[_nodeOperator] == address(0) && msg.sender == _nodeOperator))
        ) {
            revert MustBeNodeOperatorOrGuarantor();
        }
        _;
    }

    function _wcToAddress(bytes32 _withdrawalCredentials) internal pure returns (address _wcAddress) {
        uint64 _wcVersion = uint8(_withdrawalCredentials[0]);

        if (_wcVersion < 1) {
            revert WithdrawalCredentialsInvalidVersion(_wcVersion);
        }

        _wcAddress = address(uint160(uint256(_withdrawalCredentials)));
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    // * * * * * Events  * * * * * //

    event NodeOperatorBalanceToppedUp(address indexed nodeOperator, address indexed sender, uint256 amount);
    event NodeOperatorBalanceWithdrawn(address indexed nodeOperator, address indexed recipient, uint256 amount);

    event GuarantorRefunded(address indexed guarantor, address indexed nodeOperator, uint256 amount);
    event GuarantorRefundClaimed(address indexed guarantor, address indexed recipient, uint256 amount);

    event NodeOperatorGuarantorSet(address indexed nodeOperator, address indexed guarantor);
    event ValidatorsPreDeposited(
        address indexed nodeOperator,
        address indexed stakingVault,
        uint256 numberOfValidators
    );
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
    error CannotSetSelfAsGuarantor();
    error ValueMustBeMultipleOfPredepositAmount(uint256 value);
    error EmptyRefund();
    error RefundFailed();

    // predeposit errors
    error PredepositNoDeposits();
    error PredepositDepositAmountInvalid(bytes validatorPubkey, uint256 depositAmount);
    error MustBeNewValidatorPubkey(bytes validatorPubkey, validatorStage bondStatus);
    error NotEnoughUnlockedBondToPredeposit(uint256 unlocked, uint256 totalDepositAmount);
    error StakingVaultWithdrawalCredentialsMismatch(address stakingVault, address withdrawalCredentialsAddress);

    // depositing errors
    error DepositToUnprovenValidator(bytes validatorPubkey, validatorStage bondStatus);
    error DepositToWrongVault(bytes validatorPubkey, address stakingVault);
    error ValidatorNotPreDeposited(bytes validatorPubkey, validatorStage bondStatus);

    // prove
    error WithdrawalCredentialsAreInvalid();
    error WithdrawalCredentialsAreValid();
    error WithdrawalCredentialsInvalidVersion(uint64 version);
    // withdrawal proven
    error NotEnoughUnlockedBondToWithdraw(uint256 unlocked, uint256 amount);

    // withdrawal disproven
    error ValidatorNotProvenInvalid(validatorStage bondStatus);
    error WithdrawSenderNotStakingVaultOwner();
    /// withdrawal generic
    error WithdrawalFailed();
    error WithdrawToVaultNotAllowed();

    // auth
    error MustBeNodeOperatorOrGuarantor();
    error MustBeNodeOperator();

    // general
    error ZeroArgument(string argument);
}
