// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {BLS12_381} from "contracts/common/lib/BLS.sol";
import {PausableUntilWithRoles} from "contracts/0.8.25/utils/PausableUntilWithRoles.sol";

import {CLProofVerifier} from "./CLProofVerifier.sol";
import {MeIfNobodyElse} from "./MeIfNobodyElse.sol";

import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "../interfaces/IPredepositGuarantee.sol";

/**
 * @title PredepositGuarantee
 * @author Lido
 * @notice This contract acts as permissionless deposit security layer for all compatible staking vaults.
 *         It allows Node Operators(NO) to provide ether to back up their validators' deposits.
 *         While only Staking Vault ether is used to deposit to the beacon chain, NO's ether is locked.
 *         And can only be unlocked if the validator is proven to have valid Withdrawal Credentials on Ethereum Consensus Layer.
 *         Merkle proofs against Beacon Block Root are used to prove either validator's validity or invalidity
 *         where invalid validators' ether can be compensated back to the staking vault owner.
 *         A system of NO's guarantors can be used to allow NOs to handle deposits and verifications
 *         while guarantors provide ether.
 *
 *     !NB:
 *         There is a mutual trust assumption between NO's and guarantors.
 *         Internal guards for NO<->Guarantor are used only to prevent mistakes and provide operational recovery paths.
 *         But can not be used to fully prevent misbehavior in this relationship where NO's can access guarantor provided ether.
 *
 *     !NB:
 *         There is a mutual trust assumption between NO's and the assigned depositor.
 *
 *     !NB:
 *         PDG is permissionless by design. Anyone can be an NO, provided there is a compatible staking vault
 *         that has `nodeOperator()` as NO and allows PDG to perform `depositToBeaconChain()` on it.
 *
 *          - Lido's VaultHub requires all connected vaults to use PDG to ensure security of the deposited ether
 *          - PDG can be used outside of Lido
 */
contract PredepositGuarantee is IPredepositGuarantee, CLProofVerifier, PausableUntilWithRoles {
    using MeIfNobodyElse for mapping(address => address);

    /**
     * @notice represents validator stages in PDG flow
     * @param NONE - initial stage
     * @param PREDEPOSITED - PREDEPOSIT_AMOUNT is deposited with this validator by the vault
     * @param PROVEN - validator is proven to be valid and can be used to deposit to beacon chain
     * @param DISPROVEN - validator is proven to have wrong WC and its PREDEPOSIT_AMOUNT can be compensated to staking vault owner
     * @param COMPENSATED - disproven validator has its PREDEPOSIT_AMOUNT ether compensated to staking vault owner and validator cannot be used in PDG anymore
     */
    enum ValidatorStage {
        NONE,
        PREDEPOSITED,
        PROVEN,
        DISPROVEN,
        COMPENSATED
    }

    /**
     * @notice represents NO balance in PDG
     * @dev fits into single 32 bytes slot
     * @param total total ether balance of the NO
     * @param locked ether locked in not yet proven predeposits
     */
    struct NodeOperatorBalance {
        uint128 total;
        uint128 locked;
    }
    /**
     * @notice represents status of the validator in PDG
     * @dev is used to track validator from predeposit -> prove -> deposit
     * @param stage represents validator stage in PDG flow
     * @param stakingVault pins validator to specific StakingVault
     * @param nodeOperator pins validator to specific NO
     */
    struct ValidatorStatus {
        ValidatorStage stage;
        IStakingVault stakingVault;
        address nodeOperator;
    }

    /**
     * @notice ERC-7201 storage struct
     * @dev ERC-7201 namespace is used to prevent upgrade collisions
     * @custom:storage-location erc7201:Lido.Vaults.PredepositGuarantee
     * @param nodeOperatorBalance - balance of NO in PDG
     * @param nodeOperatorGuarantor - mapping of NO to its' guarantor (zero address means NO is self-guarantor)
     * @param guarantorClaimableEther - ether that guarantor can claim back if NO has changed guarantor with balance
     * @param validatorStatus - status of the validators in PDG
     */
    struct ERC7201Storage {
        mapping(address nodeOperator => NodeOperatorBalance balance) nodeOperatorBalance;
        mapping(address nodeOperator => address guarantor) nodeOperatorGuarantor;
        mapping(address guarantor => uint256 claimableEther) guarantorClaimableEther;
        mapping(bytes validatorPubkey => ValidatorStatus validatorStatus) validatorStatus;
        mapping(address nodeOperator => address depositor) nodeOperatorDepositor;
    }

    uint8 public constant MIN_SUPPORTED_WC_VERSION = 0x01;
    uint8 public constant MAX_SUPPORTED_WC_VERSION = 0x02;

    /// @notice amount of ether that is predeposited with each validator
    uint128 public constant PREDEPOSIT_AMOUNT = 1 ether;

    /**
     * @notice computed DEPOSIT_DOMAIN for current chain
     * @dev changes between chains and testnets depending on GENESIS_FORK_VERSION
     * @dev per https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_domain
     */
    bytes32 public immutable DEPOSIT_DOMAIN;

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         keccak256(abi.encode(uint256(keccak256("Lido.Vaults.PredepositGuarantee")) - 1)) & ~bytes32(uint256(0xff))
     */
    bytes32 private constant ERC7201_STORAGE_LOCATION =
        0xf66b5a365356c5798cc70e3ea6a236b181a826a69f730fc07cc548244bee5200;

    /**
     * @param _genesisForkVersion genesis fork version for the current chain
     * @param _gIFirstValidator packed(general index + depth in tree, see GIndex.sol) GIndex of first validator in CL state tree
     * @param _gIFirstValidatorAfterChange packed GIndex of first validator after fork changes tree structure
     * @param _changeSlot slot of the fork that alters first validator GIndex
     * @dev if no fork changes are known,  _gIFirstValidatorAfterChange = _gIFirstValidator and _changeSlot = 0
     */
    constructor(
        bytes4 _genesisForkVersion,
        GIndex _gIFirstValidator,
        GIndex _gIFirstValidatorAfterChange,
        uint64 _changeSlot
    ) CLProofVerifier(_gIFirstValidator, _gIFirstValidatorAfterChange, _changeSlot) {
        DEPOSIT_DOMAIN = BLS12_381.computeDepositDomain(_genesisForkVersion);
        _disableInitializers();
        _pauseUntil(PAUSE_INFINITELY);
    }

    function initialize(address _defaultAdmin) external initializer {
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");

        __AccessControlEnumerable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
    }

    // * * * * * * * * * * * * * * * * * * * * * //
    // * * * Node Operator Accounting Logic* * * //
    // * * * * * * * * * * * * * * * * * * * * * //

    /**
     * @notice returns total & locked balances for the NO
     * @param _nodeOperator to withdraw from
     * @return balance object of the node operator
     */
    function nodeOperatorBalance(address _nodeOperator) external view returns (NodeOperatorBalance memory) {
        return _getStorage().nodeOperatorBalance[_nodeOperator];
    }

    /**
     * @notice returns the amount of ether that NO can lock for predeposit or withdraw
     * @param _nodeOperator to check unlocked balance for
     * @return unlocked amount
     */
    function unlockedBalance(address _nodeOperator) external view returns (uint256 unlocked) {
        NodeOperatorBalance storage balance = _getStorage().nodeOperatorBalance[_nodeOperator];
        unlocked = balance.total - balance.locked;
    }

    /**
     * @notice returns address of the guarantor for the NO
     * @param _nodeOperator to check guarantor for
     * @return address of guarantor for the NO
     * @dev will return _nodeOperator if NO has no external guarantor
     */
    function nodeOperatorGuarantor(address _nodeOperator) external view returns (address) {
        return _guarantorOf(_nodeOperator);
    }

    /**
     * @notice returns address of the depositor for the NO
     * @param _nodeOperator to check depositor for
     * @return address of depositor for the NO
     */
    function nodeOperatorDepositor(address _nodeOperator) external view returns (address) {
        return _depositorOf(_nodeOperator);
    }

    /**
     * @notice returns amount of ether refund that guarantor can claim
     * @param _guarantor address of the guarantor
     * @return amount of ether that guarantor can claim by calling `claimGuarantorRefund(amount)`
     */
    function claimableRefund(address _guarantor) external view returns (uint256) {
        return _getStorage().guarantorClaimableEther[_guarantor];
    }

    /**
     * @notice returns PDG status of the validator by pubkey
     * @param _validatorPubkey to check status for
     * @return struct of ValidatorStatus
     */
    function validatorStatus(bytes calldata _validatorPubkey) external view returns (ValidatorStatus memory) {
        return _getStorage().validatorStatus[_validatorPubkey];
    }

    /**
     * @notice tops up NO's balance with ether provided by a guarantor
     * @param _nodeOperator address
     */
    function topUpNodeOperatorBalance(address _nodeOperator) external payable whenResumed {
        _topUpNodeOperatorBalance(_nodeOperator);
    }

    /**
     * @notice validates proof of validator in CL with withdrawalCredentials and pubkey against Beacon block root
     * @param _witness object containing validator pubkey, Merkle proof and timestamp for Beacon Block root child block
     * @param _withdrawalCredentials to verify proof with
     * @dev reverts with `InvalidProof` when provided input cannot be proven to Beacon block root
     */
    function validatePubKeyWCProof(ValidatorWitness calldata _witness, bytes32 _withdrawalCredentials) public view {
        _validatePubKeyWCProof(_witness, _withdrawalCredentials);
    }

    /**
     * @notice verifies the deposit message signature using BLS12-381 pairing check
     * @param _deposit staking vault deposit to verify
     * @param _depositsY Y coordinates of the two BLS12-381 points (uncompressed pubkey and signature)
     * @param _withdrawalCredentials withdrawal credentials of the deposit message to verify
     * @dev reverts with `InvalidSignature` if the signature is invalid
     * @dev reverts with `InputHasInfinityPoints` if the input contains infinity points(zero values)
     */
    function verifyDepositMessage(
        IStakingVault.Deposit calldata _deposit,
        BLS12_381.DepositY calldata _depositsY,
        bytes32 _withdrawalCredentials
    ) public view {
        BLS12_381.verifyDepositMessage(_deposit.pubkey, _deposit.signature, _deposit.amount, _depositsY, _withdrawalCredentials, DEPOSIT_DOMAIN);
    }

    /**
     * @notice withdraws unlocked NO's balance
     * @param _nodeOperator to withdraw from
     * @param _amount amount to withdraw
     * @param _recipient address to send the funds to
     * @dev only guarantor can withdraw
     */
    function withdrawNodeOperatorBalance(
        address _nodeOperator,
        uint256 _amount,
        address _recipient
    ) external onlyGuarantorOf(_nodeOperator) whenResumed {
        // _nodeOperator != address(0) is enforced by onlyGuarantorOf()
        if (_amount == 0) revert ZeroArgument("_amount");
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_amount % PREDEPOSIT_AMOUNT != 0) revert ValueNotMultipleOfPredepositAmount(_amount);

        NodeOperatorBalance storage balance = _getStorage().nodeOperatorBalance[_nodeOperator];

        uint256 unlocked = balance.total - balance.locked;

        if (unlocked < _amount) revert NotEnoughUnlocked(unlocked, _amount);

        balance.total -= uint128(_amount);
        (bool success, ) = _recipient.call{value: _amount}("");
        if (!success) revert WithdrawalFailed();

        emit BalanceWithdrawn(_nodeOperator, _recipient, _amount);
    }

    /**
     * @notice changes guarantor for the NO and provides refund to guarantor if NO has balance
     * @param _newGuarantor address of the new guarantor
     * @dev reverts if a NO has non-zero locked balance
     * @dev refunded ether can be claimed by previous guarantor with `claimGuarantorRefund()`
     */
    function setNodeOperatorGuarantor(address _newGuarantor) external whenResumed {
        ERC7201Storage storage $ = _getStorage();
        NodeOperatorBalance storage balance = $.nodeOperatorBalance[msg.sender];

        address prevGuarantor = _guarantorOf(msg.sender);

        if (_newGuarantor == address(0)) revert ZeroArgument("_newGuarantor");

        if (prevGuarantor == _newGuarantor) revert SameGuarantor();

        if (balance.locked != 0) revert LockedIsNotZero(balance.locked);

        if (balance.total > 0) {
            uint256 refund = balance.total;
            balance.total = 0;

            $.guarantorClaimableEther[prevGuarantor] += refund;

            emit BalanceRefunded(msg.sender, _newGuarantor);
            emit GuarantorRefundAdded(prevGuarantor, msg.sender, refund);
        }

        $.nodeOperatorGuarantor.setOrReset(msg.sender, _newGuarantor);

        emit GuarantorSet(msg.sender, _newGuarantor, prevGuarantor);
    }

    /**
     * @notice sets the depositor for the NO
     * @param _newDepositor address of the depositor
     */
    function setNodeOperatorDepositor(address _newDepositor) external {
        if (_newDepositor == address(0)) revert ZeroArgument("_newDepositor");
        address prevDepositor = _depositorOf(msg.sender);
        if (_newDepositor == prevDepositor) revert SameDepositor();

        _getStorage().nodeOperatorDepositor.setOrReset(msg.sender, _newDepositor);

        emit DepositorSet(msg.sender, _newDepositor, prevDepositor);
    }

    /**
     * @notice claims refund for the previous guarantor of the NO
     * @param _recipient address to send the refund to
     * @return claimedEther amount of refund
     */
    function claimGuarantorRefund(address _recipient) external whenResumed returns (uint256 claimedEther) {
        ERC7201Storage storage $ = _getStorage();

        claimedEther = $.guarantorClaimableEther[msg.sender];

        if (claimedEther == 0) revert NothingToRefund();

        $.guarantorClaimableEther[msg.sender] = 0;

        (bool success, ) = _recipient.call{value: claimedEther}("");

        if (!success) revert RefundFailed();

        emit GuarantorRefundClaimed(msg.sender, _recipient, claimedEther);
    }

    // * * * * * * * * * * * * * * * * * * * * //
    // * * * * * Deposit Operations  * * * * * //
    // * * * * * * * * * * * * * * * * * * * * //

    /**
     * @notice deposits NO's validators with PREDEPOSIT_AMOUNT ether from StakingVault and locks up NO's balance
     * @dev optionally accepts multiples of`PREDEPOSIT_AMOUNT` in `msg.value` to top up NO balance if NO is self-guarantor
     * @param _stakingVault to deposit validators to
     * @param _deposits StakingVault deposit struct that has amount as PREDEPOSIT_AMOUNT
     */
    function predeposit(
        IStakingVault _stakingVault,
        IStakingVault.Deposit[] calldata _deposits,
        BLS12_381.DepositY[] calldata _depositsY
    ) external payable whenResumed {
        if (_deposits.length == 0) revert EmptyDeposits();

        address nodeOperator = _stakingVault.nodeOperator();
        if (msg.sender != _depositorOf(nodeOperator)) revert NotDepositor();

        if (msg.value != 0) {
            // check that node operator is self-guarantor is inside
            _topUpNodeOperatorBalance(nodeOperator);
        }

        bytes32 withdrawalCredentials = _stakingVault.withdrawalCredentials();

        // sanity check that vault returns valid WC
        _validateWC(_stakingVault, withdrawalCredentials);

        ERC7201Storage storage $ = _getStorage();
        NodeOperatorBalance storage balance = $.nodeOperatorBalance[nodeOperator];

        uint128 totalDepositAmount = PREDEPOSIT_AMOUNT * uint128(_deposits.length);
        uint128 unlocked = balance.total - balance.locked;

        if (unlocked < totalDepositAmount) revert NotEnoughUnlocked(unlocked, totalDepositAmount);

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVault.Deposit calldata _deposit = _deposits[i];

            // this check isn't needed in  `depositToBeaconChain` because
            // Beacon Chain doesn't enforce the signature checks for existing validators and just top-ups to their balance
            verifyDepositMessage(_deposit, _depositsY[i], withdrawalCredentials);

            if ($.validatorStatus[_deposit.pubkey].stage != ValidatorStage.NONE) {
                revert ValidatorNotNew(_deposit.pubkey, $.validatorStatus[_deposit.pubkey].stage);
            }

            if (_deposit.amount != PREDEPOSIT_AMOUNT) revert PredepositAmountInvalid(_deposit.pubkey, _deposit.amount);

            $.validatorStatus[_deposit.pubkey] = ValidatorStatus({
                stage: ValidatorStage.PREDEPOSITED,
                stakingVault: _stakingVault,
                nodeOperator: nodeOperator
            });

            emit ValidatorPreDeposited(_deposit.pubkey, nodeOperator, address(_stakingVault), withdrawalCredentials);
        }

        balance.locked += totalDepositAmount;
        _stakingVault.depositToBeaconChain(_deposits);

        emit BalanceLocked(nodeOperator, balance.total, balance.locked);
    }

    // * * * * * Positive Proof Flow  * * * * * //

    /**
     * @notice permissionless method to prove correct Withdrawal Credentials for the validator on CL
     * @param _witness object containing validator pubkey, Merkle proof and timestamp for Beacon Block root child block
     * @dev will revert if proof is invalid or misformed or validator is not predeposited
     */
    function proveValidatorWC(ValidatorWitness calldata _witness) public whenResumed {
        ValidatorStatus storage validator = _getStorage().validatorStatus[_witness.pubkey];

        // checking stage here prevents revert on call to zero address at `.stakingVault.withdrawalCredentials()`
        if (validator.stage != ValidatorStage.PREDEPOSITED) {
            revert ValidatorNotPreDeposited(_witness.pubkey, validator.stage);
        }

        // WC will be sanity checked in `_processPositiveProof()`
        bytes32 withdrawalCredentials = validator.stakingVault.withdrawalCredentials();

        validatePubKeyWCProof(_witness, withdrawalCredentials);

        _processPositiveProof(_witness.pubkey, validator, withdrawalCredentials);
    }

    /**
     * @notice deposits ether to proven validators from staking vault
     * @param _stakingVault address
     * @param _deposits array of StakingVault.Deposit structs
     * @dev only callable by Node Operator of this staking vault
     */
    function depositToBeaconChain(
        IStakingVault _stakingVault,
        IStakingVault.Deposit[] calldata _deposits
    ) public payable whenResumed {
        if (msg.sender != _depositorOf(_stakingVault.nodeOperator())) {
            revert NotDepositor();
        }
        ERC7201Storage storage $ = _getStorage();

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVault.Deposit calldata _deposit = _deposits[i];

            ValidatorStatus storage validator = $.validatorStatus[_deposit.pubkey];

            if (validator.stage != ValidatorStage.PROVEN) {
                revert DepositToUnprovenValidator(_deposit.pubkey, $.validatorStatus[_deposit.pubkey].stage);
            }

            // sanity check because first check relies on external contract
            if (_depositorOf(validator.nodeOperator) != msg.sender) {
                revert NotDepositor();
            }

            if (validator.stakingVault != _stakingVault) {
                revert DepositToWrongVault(_deposit.pubkey, address(_stakingVault));
            }
        }

        _stakingVault.depositToBeaconChain(_deposits);
    }

    /**
     * @notice happy path shortcut for the node operator that allows:
     * - prove validators to unlock NO balance
     * - optionally top up NO balance
     * - trigger deposit to proven validators via vault
     * @param _witnesses array of ValidatorWitness structs to prove validators WCs
     * @param _deposits array of StakingVault.Deposit structs with deposit data for provided _stakingVault
     * @param _stakingVault address
     * @param _deposits array of StakingVault.Deposit structs
     * @dev proven validators and  staking vault + deposited validators don't have to match
     */
    function proveAndDeposit(
        ValidatorWitness[] calldata _witnesses,
        IStakingVault.Deposit[] calldata _deposits,
        IStakingVault _stakingVault
    ) external payable {
        for (uint256 i = 0; i < _witnesses.length; i++) {
            proveValidatorWC(_witnesses[i]);
        }

        depositToBeaconChain(_stakingVault, _deposits);
    }

    /**
     * @notice shortcut if validator already has valid WC setup
     * @param _witness  ValidatorWitness struct proving validator WC belong to staking vault
     * @param _stakingVault address
     * @dev only callable by staking vault owner & only if validator stage is NONE
     */
    function proveUnknownValidator(
        ValidatorWitness calldata _witness,
        IStakingVault _stakingVault
    ) external whenResumed {
        if (_stakingVault.owner() != msg.sender) revert NotStakingVaultOwner();

        ERC7201Storage storage $ = _getStorage();

        if ($.validatorStatus[_witness.pubkey].stage != ValidatorStage.NONE) {
            revert ValidatorNotNew(_witness.pubkey, $.validatorStatus[_witness.pubkey].stage);
        }

        bytes32 withdrawalCredentials = _stakingVault.withdrawalCredentials();

        // sanity check that vault returns valid WC
        _validateWC(_stakingVault, withdrawalCredentials);

        validatePubKeyWCProof(_witness, withdrawalCredentials);

        $.validatorStatus[_witness.pubkey] = ValidatorStatus({
            stage: ValidatorStage.PROVEN,
            stakingVault: _stakingVault,
            nodeOperator: _stakingVault.nodeOperator()
        });

        emit ValidatorProven(
            _witness.pubkey,
            $.validatorStatus[_witness.pubkey].nodeOperator,
            address(_stakingVault),
            withdrawalCredentials
        );
    }

    // * * * * * Negative Proof Flow  * * * * * //

    /**
     * @notice permissionless method to prove incorrect Withdrawal Credentials for the validator on CL
     * @param _witness object containing validator pubkey, Merkle proof and timestamp for Beacon Block root child block
     * @param _invalidWithdrawalCredentials with which validator was deposited before PDG's predeposit
     * @dev will revert if proof is invalid, validator is not predeposited or withdrawal credentials belong to correct vault
     * @dev validator WC versions mismatch (e.g 0x01 vs 0x02) will be treated as invalid WC
     */
    function proveInvalidValidatorWC(
        ValidatorWitness calldata _witness,
        bytes32 _invalidWithdrawalCredentials
    ) public whenResumed {
        validatePubKeyWCProof(_witness, _invalidWithdrawalCredentials);

        // validator state and WC incorrectness are enforced inside
        _processNegativeProof(_witness.pubkey, _invalidWithdrawalCredentials);
    }

    /**
     * @notice returns locked ether to the staking vault owner if validator's WC were proven invalid
     * @param _validatorPubkey to take locked PREDEPOSIT_AMOUNT ether from
     * @param _recipient address to transfer PREDEPOSIT_AMOUNT ether to
     * @dev can only be called by owner of vault that had deposited to disproven validator
     */
    function compensateDisprovenPredeposit(
        bytes calldata _validatorPubkey,
        address _recipient
    ) public whenResumed returns (uint256) {
        ValidatorStatus storage validator = _getStorage().validatorStatus[_validatorPubkey];

        IStakingVault stakingVault = validator.stakingVault;
        address nodeOperator = validator.nodeOperator;

        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_recipient == address(stakingVault)) revert CompensateToVaultNotAllowed();
        if (validator.stage != ValidatorStage.DISPROVEN) revert ValidatorNotDisproven(validator.stage);
        if (msg.sender != stakingVault.owner()) revert NotStakingVaultOwner();

        validator.stage = ValidatorStage.COMPENSATED;

        // reduces total&locked NO balance
        NodeOperatorBalance storage balance = _getStorage().nodeOperatorBalance[nodeOperator];
        balance.total -= PREDEPOSIT_AMOUNT;
        balance.locked -= PREDEPOSIT_AMOUNT;

        (bool success, ) = _recipient.call{value: PREDEPOSIT_AMOUNT}("");
        if (!success) revert CompensateFailed();

        emit BalanceCompensated(nodeOperator, _recipient, balance.total, balance.locked);
        emit ValidatorCompensated(_validatorPubkey, nodeOperator, address(stakingVault), _recipient);
        return PREDEPOSIT_AMOUNT;
    }

    // * * * * * * * * * * * * * * * * * * * * //
    // * * * * * Internal Functions * * * * *  //
    // * * * * * * * * * * * * * * * * * * * * //

    function _processPositiveProof(
        bytes calldata _pubkey,
        ValidatorStatus storage validator,
        bytes32 _withdrawalCredentials
    ) internal {
        // sanity check that vault returns valid WC
        _validateWC(validator.stakingVault, _withdrawalCredentials);

        validator.stage = ValidatorStage.PROVEN;
        NodeOperatorBalance storage balance = _getStorage().nodeOperatorBalance[validator.nodeOperator];
        balance.locked -= PREDEPOSIT_AMOUNT;

        emit BalanceUnlocked(validator.nodeOperator, balance.total, balance.locked);
        emit ValidatorProven(_pubkey, validator.nodeOperator, address(validator.stakingVault), _withdrawalCredentials);
    }

    function _processNegativeProof(bytes calldata _pubkey, bytes32 _invalidWithdrawalCredentials) internal {
        ERC7201Storage storage $ = _getStorage();
        ValidatorStatus storage validator = $.validatorStatus[_pubkey];

        if (validator.stage != ValidatorStage.PREDEPOSITED) {
            revert ValidatorNotPreDeposited(_pubkey, validator.stage);
        }

        bytes32 vaultWithdrawalCredentials = validator.stakingVault.withdrawalCredentials();

        // sanity check that vault returns valid WC
        _validateWC(validator.stakingVault, vaultWithdrawalCredentials);

        // this check prevents negative proving for legit deposits
        if (_invalidWithdrawalCredentials == vaultWithdrawalCredentials) {
            revert WithdrawalCredentialsMatch();
        }

        validator.stage = ValidatorStage.DISPROVEN;

        emit ValidatorDisproven(
            _pubkey,
            validator.nodeOperator,
            address(validator.stakingVault),
            _invalidWithdrawalCredentials
        );
    }

    function _topUpNodeOperatorBalance(address _nodeOperator) internal onlyGuarantorOf(_nodeOperator) {
        uint128 amount = uint128(msg.value);

        // _nodeOperator != address(0) is enforced by onlyGuarantorOf()
        if (amount == 0) revert ZeroArgument("msg.value");
        if (amount % PREDEPOSIT_AMOUNT != 0) revert ValueNotMultipleOfPredepositAmount(amount);

        _getStorage().nodeOperatorBalance[_nodeOperator].total += uint128(amount);

        emit BalanceToppedUp(_nodeOperator, msg.sender, amount);
    }

    /// @notice returns guarantor of the NO
    /// @dev if guarantor is not set, returns NO address
    function _guarantorOf(address _nodeOperator) internal view returns (address) {
        return _getStorage().nodeOperatorGuarantor.getValueOrKey(_nodeOperator);
    }

    /// @notice enforces that only NO's guarantor can call the function
    modifier onlyGuarantorOf(address _nodeOperator) {
        if (_guarantorOf(_nodeOperator) != msg.sender) {
            revert NotGuarantor();
        }
        _;
    }

    /// @notice returns depositor of the NO
    /// @dev if depositor is not set, returns NO address
    function _depositorOf(address _nodeOperator) internal view returns (address) {
        return _getStorage().nodeOperatorDepositor.getValueOrKey(_nodeOperator);
    }

    /// @notice validates that WC belong to the vault
    function _validateWC(IStakingVault _stakingVault, bytes32 _withdrawalCredentials) internal pure {
        uint8 version = uint8(_withdrawalCredentials[0]);
        address wcAddress = address(uint160(uint256(_withdrawalCredentials)));

        if (version < MIN_SUPPORTED_WC_VERSION || version > MAX_SUPPORTED_WC_VERSION) {
            revert WithdrawalCredentialsInvalidVersion(version);
        }

        // extract zero bytes between version and address in WC
        if (((_withdrawalCredentials << 8) >> 168) != bytes32(0))
            revert WithdrawalCredentialsMisformed(_withdrawalCredentials);

        if (address(_stakingVault) != wcAddress) {
            revert WithdrawalCredentialsMismatch(address(_stakingVault), wcAddress);
        }
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    // * * * * * Events  * * * * * //

    /// NO balance change events

    event BalanceToppedUp(address indexed nodeOperator, address indexed sender, uint256 amount);
    event BalanceWithdrawn(address indexed nodeOperator, address indexed recipient, uint256 amount);
    event BalanceLocked(address indexed nodeOperator, uint128 total, uint128 locked);
    event BalanceUnlocked(address indexed nodeOperator, uint128 total, uint128 locked);
    event BalanceCompensated(address indexed nodeOperator, address indexed to, uint128 total, uint128 locked);
    event BalanceRefunded(address indexed nodeOperator, address indexed to);

    /// NO delegate events

    event GuarantorSet(address indexed nodeOperator, address indexed newGuarantor, address indexed prevGuarantor);
    event DepositorSet(address indexed nodeOperator, address indexed newDepositor, address indexed prevDepositor);

    event GuarantorRefundAdded(address indexed guarantor, address indexed nodeOperator, uint256 amount);
    event GuarantorRefundClaimed(address indexed guarantor, address indexed recipient, uint256 amount);

    /// Validator lifecycle events

    event ValidatorPreDeposited(
        bytes indexed validatorPubkey,
        address indexed nodeOperator,
        address indexed stakingVault,
        bytes32 withdrawalCredentials
    );
    event ValidatorProven(
        bytes indexed validatorPubkey,
        address indexed nodeOperator,
        address indexed stakingVault,
        bytes32 withdrawalCredentials
    );
    event ValidatorDisproven(
        bytes indexed validatorPubkey,
        address indexed nodeOperator,
        address indexed stakingVault,
        bytes32 invalidWithdrawalCredentials
    );
    event ValidatorCompensated(
        bytes indexed validatorPubkey,
        address indexed nodeOperator,
        address indexed stakingVault,
        address recipient
    );

    // * * * * * Errors  * * * * * //

    // node operator accounting
    error LockedIsNotZero(uint256 locked);
    error ValueNotMultipleOfPredepositAmount(uint256 value);
    error NothingToRefund();
    error WithdrawalFailed();
    error SameGuarantor();
    error SameDepositor();
    error RefundFailed();

    // predeposit errors
    error EmptyDeposits();
    error PredepositAmountInvalid(bytes validatorPubkey, uint256 depositAmount);
    error ValidatorNotNew(bytes validatorPubkey, ValidatorStage stage);
    error NotEnoughUnlocked(uint256 unlocked, uint256 amount);
    error WithdrawalCredentialsMismatch(address stakingVault, address withdrawalCredentialsAddress);

    // depositing errors
    error DepositToUnprovenValidator(bytes validatorPubkey, ValidatorStage stage);
    error DepositToWrongVault(bytes validatorPubkey, address stakingVault);

    // prove
    error ValidatorNotPreDeposited(bytes validatorPubkey, ValidatorStage stage);
    error WithdrawalCredentialsMatch();
    error WithdrawalCredentialsMisformed(bytes32 withdrawalCredentials);
    error WithdrawalCredentialsInvalidVersion(uint8 version);

    // compensate
    error ValidatorNotDisproven(ValidatorStage stage);
    error CompensateFailed();
    error CompensateToVaultNotAllowed();

    // auth
    error NotStakingVaultOwner();
    error NotGuarantor();
    error NotDepositor();

    // general
    error ZeroArgument(string argument);
}
