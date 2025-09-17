// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex} from "contracts/common/lib/GIndex.sol";
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
        mapping(address stakingVault => uint256 balance) pendingPredeposits;
    }

    /**
     * @notice represents validator stages in PDG flow
     * @param NONE - initial stage
     * @param PREDEPOSITED - PREDEPOSIT_AMOUNT is deposited with this validator by the vault
     * @param PROVEN - validator is proven to be valid and can be used to deposit to beacon chain
     * @param COMPENSATED - disproven validator has its PREDEPOSIT_AMOUNT ether compensated to staking vault owner and validator cannot be used in PDG anymore
     */
    enum ValidatorStage {
        NONE,
        PREDEPOSITED,
        PROVEN,
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

    uint8 public constant MIN_SUPPORTED_WC_VERSION = 0x01;
    uint8 public constant MAX_SUPPORTED_WC_VERSION = 0x02;

    /// @notice amount of ether that is predeposited with each validator
    uint128 public constant PREDEPOSIT_AMOUNT = 1 ether;

    /// @notice amount of ether to be deposited after the predeposit to activate the validator
    uint256 public constant ACTIVATION_DEPOSIT_AMOUNT = 31 ether;

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
        return _storage().nodeOperatorBalance[_nodeOperator];
    }

    /**
     * @notice returns the amount of ether that NO can lock for predeposit or withdraw
     * @param _nodeOperator to check unlocked balance for
     * @return unlocked amount
     */
    function unlockedBalance(address _nodeOperator) external view returns (uint256 unlocked) {
        NodeOperatorBalance storage balance = _storage().nodeOperatorBalance[_nodeOperator];
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
        return _storage().guarantorClaimableEther[_guarantor];
    }

    /**
     * @notice returns PDG status of the validator by pubkey
     * @param _validatorPubkey to check status for
     * @return struct of ValidatorStatus
     */
    function validatorStatus(bytes calldata _validatorPubkey) external view returns (ValidatorStatus memory) {
        return _storage().validatorStatus[_validatorPubkey];
    }

    /**
     * @notice returns the current amount of ether that is predeposited to a given vault
     * @param _vault staking vault address
     * @return amount of ether in wei
     */
    function pendingPredeposits(IStakingVault _vault) external view returns (uint256) {
        return _storage().pendingPredeposits[address(_vault)];
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
    function validatePubKeyWCProof(ValidatorWitness calldata _witness, bytes32 _withdrawalCredentials) external view {
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

        NodeOperatorBalance storage balance = _storage().nodeOperatorBalance[_nodeOperator];

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
        ERC7201Storage storage $ = _storage();
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

        _storage().nodeOperatorDepositor.setOrReset(msg.sender, _newDepositor);

        emit DepositorSet(msg.sender, _newDepositor, prevDepositor);
    }

    /**
     * @notice claims refund for the previous guarantor of the NO
     * @param _recipient address to send the refund to
     * @return claimedEther amount of refund
     */
    function claimGuarantorRefund(address _recipient) external whenResumed returns (uint256 claimedEther) {
        ERC7201Storage storage $ = _storage();

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
     * @notice deposits validators with PREDEPOSIT_AMOUNT ether from StakingVault, locks up NO's balance
     *         and stage ACTIVATION_DEPOSIT_AMOUNT on StakingVault for further validator activation
     * @dev optionally accepts multiples of`PREDEPOSIT_AMOUNT` in `msg.value` to top up NO balance if NO is self-guarantor
     * @param _stakingVault address of the StakingVault to use as withdrawal credentials for the deposited validator
     * @param _deposits array of deposit data with amount set as PREDEPOSIT_AMOUNT
     * @param _depositsY array of uncompressed pubkey data to verify the signature for each deposit
     */
    function predeposit(
        IStakingVault _stakingVault,
        IStakingVault.Deposit[] calldata _deposits,
        BLS12_381.DepositY[] calldata _depositsY
    ) external payable whenResumed {
        if (_deposits.length == 0) revert EmptyDeposits();
        if (_depositsY.length != _deposits.length) revert InvalidDepositYLength();

        address nodeOperator = _stakingVault.nodeOperator();
        if (msg.sender != _depositorOf(nodeOperator)) revert NotDepositor();

        if (msg.value != 0) {
            // check that node operator is self-guarantor is inside
            _topUpNodeOperatorBalance(nodeOperator);
        }

        bytes32 withdrawalCredentials = _stakingVault.withdrawalCredentials();

        // sanity check that vault returns valid WC
        _validateWC(_stakingVault, withdrawalCredentials);

        ERC7201Storage storage $ = _storage();
        NodeOperatorBalance storage balance = $.nodeOperatorBalance[nodeOperator];

        uint256 totalDepositAmount = PREDEPOSIT_AMOUNT * _deposits.length;
        uint256 unlockedGuarantee = balance.total - balance.locked;

        if (unlockedGuarantee < totalDepositAmount) revert NotEnoughUnlocked(unlockedGuarantee, totalDepositAmount);

        // stashing 31 ETH to be able to activate the validator as it gets proved
        _stakingVault.stage(ACTIVATION_DEPOSIT_AMOUNT * _deposits.length);

        balance.locked += uint128(totalDepositAmount);
        emit BalanceLocked(nodeOperator, balance.total, balance.locked);

        $.pendingPredeposits[address(_stakingVault)] += _deposits.length * PREDEPOSIT_AMOUNT;

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVault.Deposit calldata _deposit = _deposits[i];

            if (_deposit.amount != PREDEPOSIT_AMOUNT) revert PredepositAmountInvalid(_deposit.pubkey, _deposit.amount);

            // this check isn't needed in  `depositToBeaconChain` because
            // Beacon Chain doesn't enforce the signature checks for existing validators and just top-ups to their balance
            verifyDepositMessage(_deposit, _depositsY[i], withdrawalCredentials);

            _createValidatorStatus(_deposit.pubkey,
                ValidatorStatus({
                    stage: ValidatorStage.PREDEPOSITED,
                    stakingVault: _stakingVault,
                    nodeOperator: nodeOperator
                })
            );

            _stakingVault.depositToBeaconChain(_deposit);

            emit ValidatorPreDeposited(_deposit.pubkey, nodeOperator, address(_stakingVault), withdrawalCredentials);
        }
    }

    // * * * * * Positive Proof Flow  * * * * * //

    /**
     * @notice permissionless method to prove correct Withdrawal Credentials for the validator
     *         and to send the activation deposit
     * @param _witness object containing validator pubkey, Merkle proof and timestamp for Beacon Block root child block
     * @dev will revert if proof is invalid or misformed or validator is not predeposited
     * @dev will **not** revert if activation is impossible, but it may result in the vault's total value drop
     */
    function proveWCAndActivateValidator(ValidatorWitness calldata _witness) public whenResumed {
        ValidatorStatus storage validator = _storage().validatorStatus[_witness.pubkey];

        // checking stage here prevents revert on call to zero address at `.stakingVault.withdrawalCredentials()`
        if (validator.stage != ValidatorStage.PREDEPOSITED) {
            revert ValidatorNotPreDeposited(_witness.pubkey, validator.stage);
        }

        IStakingVault vault = validator.stakingVault;
        bytes32 withdrawalCredentials = vault.withdrawalCredentials();

        // sanity check that vault returns valid WC
        _validateWC(validator.stakingVault, withdrawalCredentials);
        _validatePubKeyWCProof(_witness, withdrawalCredentials);

        validator.stage = ValidatorStage.PROVEN;
        NodeOperatorBalance storage balance = _storage().nodeOperatorBalance[validator.nodeOperator];
        balance.locked -= PREDEPOSIT_AMOUNT;
        _storage().pendingPredeposits[address(validator.stakingVault)] -= PREDEPOSIT_AMOUNT;

        emit BalanceUnlocked(validator.nodeOperator, balance.total, balance.locked);
        emit ValidatorProven(_witness.pubkey, validator.nodeOperator, address(validator.stakingVault), withdrawalCredentials);

        // if the vault is disconnected from VaultHub and changed depositor or unstaged ether
        // skip the activation to unlock node operator's guarantee
        if (vault.depositor() == address(this) && vault.stagedBalance() >= ACTIVATION_DEPOSIT_AMOUNT) {
            _activateValidator(vault, _witness.pubkey, withdrawalCredentials);
        }
    }

    /**
     * @notice deposits ether to proven validators from staking vault
     * @param _stakingVault address
     * @param _deposits array of StakingVault.Deposit structs
     * @dev only callable by the depositor assigned by the node operator of the given staking vault
     */
    function depositToBeaconChain(
        IStakingVault _stakingVault,
        IStakingVault.Deposit[] calldata _deposits
    ) public whenResumed {
        if (msg.sender != _depositorOf(_stakingVault.nodeOperator())) {
            revert NotDepositor();
        }

        ERC7201Storage storage $ = _storage();

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVault.Deposit calldata _deposit = _deposits[i];

            ValidatorStatus storage validator = $.validatorStatus[_deposit.pubkey];

            if (validator.stage != ValidatorStage.PROVEN) {
                revert DepositToUnprovenValidator(_deposit.pubkey, validator.stage);
            }

            // sanity check because first check relies on external contract
            if (_depositorOf(validator.nodeOperator) != msg.sender) {
                revert NotDepositor();
            }

            if (validator.stakingVault != _stakingVault) {
                revert DepositToWrongVault(_deposit.pubkey, address(_stakingVault));
            }
             _stakingVault.depositToBeaconChain(_deposit);
        }
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
            proveWCAndActivateValidator(_witnesses[i]);
        }

        depositToBeaconChain(_stakingVault, _deposits);
    }

    /**
     * @notice proves the side-deposited validator's WC to allow depositing to it through PDG
     * @param _witness  ValidatorWitness struct proving validator WC belongs to the staking vault
     * @param _stakingVault address of the StakingVault
     * @dev only callable by staking vault owner & only if validator stage is NONE
     * @dev reverts if the validator is not eligible for activation
     *      (to prevent validators that is not withdrawable by EIP-7002)
     */
    function proveUnknownValidator(
        ValidatorWitness calldata _witness,
        IStakingVault _stakingVault
    ) external whenResumed {
        if (_stakingVault.owner() != msg.sender) revert NotStakingVaultOwner();

        // Filter out validators not eligible for activation (all epochs are set to FAR_FUTURE_EPOCH)
        //
        // sha256(
        //  sha256(FAR_FUTURE_EPOCH|FAR_FUTURE_EPOCH) |  // activation_eligibility_epoch | activation_epoch
        //  sha256(FAR_FUTURE_EPOCH|FAR_FUTURE_EPOCH)    // exit_epoch  | withdrawable_epoch
        // )
        // see CLProofVerifier.sol for Validator Container Root scheme that explains the proof positioning
        if (_witness.proof[1] == 0x2c84ba62dc4e7011c24fb0878e3ef2245a9e2cf2cacbbaf2978a4efa47037283) {
            revert ValidatorNotEligibleForActivation(_witness.pubkey);
        }

        bytes32 withdrawalCredentials = _stakingVault.withdrawalCredentials();
        // sanity check that vault returns valid WC
        _validateWC(_stakingVault, withdrawalCredentials);
        _validatePubKeyWCProof(_witness, withdrawalCredentials);
        address nodeOperator = _stakingVault.nodeOperator();

        _createValidatorStatus(_witness.pubkey,
            ValidatorStatus({
                stage: ValidatorStage.PROVEN,
                stakingVault: _stakingVault,
                nodeOperator: nodeOperator
            })
        );

        emit ValidatorProven(
            _witness.pubkey,
            nodeOperator,
            address(_stakingVault),
            withdrawalCredentials
        );
    }

    // * * * * * Negative Proof Flow  * * * * * //

    /**
     * @notice permissionless method to prove and compensate incorrect Withdrawal Credentials for the validator on CL
     * @param _witness object containing validator pubkey, Merkle proof and timestamp for Beacon Block root child block
     * @param _invalidWithdrawalCredentials with which validator was deposited before PDG's predeposit
     * @dev will revert if proof is invalid, validator is not predeposited or withdrawal credentials belong to correct vault
     * @dev validator WC versions mismatch (e.g 0x01 vs 0x02) will be treated as invalid WC
     */
    function proveInvalidValidatorWC(
        ValidatorWitness calldata _witness,
        bytes32 _invalidWithdrawalCredentials
    ) public whenResumed returns (uint256) {
        _validatePubKeyWCProof(_witness, _invalidWithdrawalCredentials);

        ERC7201Storage storage $ = _storage();
        ValidatorStatus storage validator = $.validatorStatus[_witness.pubkey];

        // validator state and WC incorrectness are enforced inside
        if (validator.stage != ValidatorStage.PREDEPOSITED) {
            revert ValidatorNotPreDeposited(_witness.pubkey, validator.stage);
        }

        IStakingVault stakingVault = validator.stakingVault;
        bytes32 vaultWithdrawalCredentials = stakingVault.withdrawalCredentials();

        // sanity check that vault returns valid WC
        _validateWC(stakingVault, vaultWithdrawalCredentials);

        // this check prevents negative proving for legit deposits
        if (_invalidWithdrawalCredentials == vaultWithdrawalCredentials) {
            revert WithdrawalCredentialsMatch();
        }

        // immediately compensate the staking vault
        validator.stage = ValidatorStage.COMPENSATED;

        address nodeOperator = validator.nodeOperator;

        // reduces total&locked NO balance
        NodeOperatorBalance storage balance = $.nodeOperatorBalance[nodeOperator];
        balance.total -= PREDEPOSIT_AMOUNT;
        balance.locked -= PREDEPOSIT_AMOUNT;
        $.pendingPredeposits[address(stakingVault)] -= PREDEPOSIT_AMOUNT;

        // unlocking the stashed amount as we are not activating this validator
        stakingVault.unstage(ACTIVATION_DEPOSIT_AMOUNT);

        // transfer the compensation directly to the vault
        (bool success, ) = address(stakingVault).call{value: PREDEPOSIT_AMOUNT}("");
        if (!success) revert CompensateFailed();

        emit ValidatorCompensated(address(stakingVault), nodeOperator, _witness.pubkey, balance.total, balance.locked);

        return PREDEPOSIT_AMOUNT;
    }

    // * * * * * * * * * * * * * * * * * * * * //
    // * * * * * Internal Functions * * * * *  //
    // * * * * * * * * * * * * * * * * * * * * //

    function _createValidatorStatus(bytes calldata _pubkey, ValidatorStatus memory _validator) internal {
        mapping(bytes validatorPubkey => ValidatorStatus) storage validatorByPubkey = _storage().validatorStatus;

        ValidatorStatus storage validator = validatorByPubkey[_pubkey];
        if (validator.stage != ValidatorStage.NONE) {
            revert ValidatorNotNew(_pubkey, validator.stage);
        }

        validatorByPubkey[_pubkey] = _validator;
    }

    /// @dev deposits ACTIVATION_DEPOSIT_AMOUNT to the predeposited validator,
    /// so oracle can count it as a part of the total value
    function _activateValidator(
        IStakingVault _stakingVault,
        bytes calldata _pubkey,
        bytes32 _withdrawalCredentials
    ) internal {
        IStakingVault.Deposit memory deposit = IStakingVault.Deposit({
            pubkey: _pubkey,
            signature: new bytes(96),
            amount: ACTIVATION_DEPOSIT_AMOUNT,
            depositDataRoot: _depositDataRoot31ETHWithZeroSig(_pubkey, _withdrawalCredentials)
        });

        _stakingVault.depositFromStaged(deposit);
    }

    /// @dev the edge case deposit data root for zero signature and 31 ETH amount
    function _depositDataRoot31ETHWithZeroSig(bytes calldata _pubkey, bytes32 _withdrawalCredentials) internal pure returns (bytes32) {
        bytes32 pubkeyRoot = sha256(bytes.concat(_pubkey, bytes16(0)));

        // sha256(sha256(0x0)|sha256(0x0))
        bytes32 zeroSignatureRoot = 0xdb56114e00fdd4c1f85c892bf35ac9a89289aaecb1ebd0a96cde606a748b5d71;

        // to_little_endian_64(uint64(ACTIVATION_DEPOSIT_AMOUNT / 1 gwei))
        bytes8 amountLE64 = 0x0076be3707000000;

        return sha256(bytes.concat(
            sha256(bytes.concat(pubkeyRoot, _withdrawalCredentials)),
            sha256(bytes.concat(amountLE64, bytes24(0), zeroSignatureRoot))
        ));
    }

    function _topUpNodeOperatorBalance(address _nodeOperator) internal onlyGuarantorOf(_nodeOperator) {
        uint128 amount = uint128(msg.value);

        // _nodeOperator != address(0) is enforced by onlyGuarantorOf()
        if (amount == 0) revert ZeroArgument("msg.value");
        if (amount % PREDEPOSIT_AMOUNT != 0) revert ValueNotMultipleOfPredepositAmount(amount);

        _storage().nodeOperatorBalance[_nodeOperator].total += uint128(amount);

        emit BalanceToppedUp(_nodeOperator, msg.sender, amount);
    }

    /// @notice returns guarantor of the NO
    /// @dev if guarantor is not set, returns NO address
    function _guarantorOf(address _nodeOperator) internal view returns (address) {
        return _storage().nodeOperatorGuarantor.getValueOrKey(_nodeOperator);
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
        return _storage().nodeOperatorDepositor.getValueOrKey(_nodeOperator);
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

    function _storage() private pure returns (ERC7201Storage storage $) {
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
    event ValidatorCompensated(
        address indexed stakingVault,
        address indexed nodeOperator,
        bytes indexed validatorPubkey,
        uint256 guaranteeTotal,
        uint256 guaranteeLocked
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
    error InvalidDepositYLength();
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
    error ValidatorNotEligibleForActivation(bytes validatorPubkey);

    // compensate
    error CompensateFailed();

    // auth
    error NotStakingVaultOwner();
    error NotGuarantor();
    error NotDepositor();

    // general
    error ZeroArgument(string argument);
}
