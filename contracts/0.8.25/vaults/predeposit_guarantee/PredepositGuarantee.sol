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
 *         Merkle proofs against Beacon Block Root (EIP-4788) are used to prove either validator's validity or invalidity
 *         where invalid validators' ether can be compensated back to the staking vault.
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
 *          - PDG can be used by staking vaults not connected to VaultHub
 */
contract PredepositGuarantee is IPredepositGuarantee, CLProofVerifier, PausableUntilWithRoles {
    using MeIfNobodyElse for mapping(address => address);

    /**
     * @notice ERC-7201 storage struct
     * @custom:storage-location erc7201:Lido.Vaults.PredepositGuarantee
     * @param nodeOperatorBalance - balance of NO in PDG
     * @param nodeOperatorGuarantor - mapping of NO to its' guarantor (zero address means NO is self-guarantor)
     * @param guarantorClaimableEther - ether that guarantor can claim back if NO has changed guarantor with balance
     * @param validatorStatus - status of the validators in PDG
     * @param nodeOperatorDepositor - address delegated by the node operator to be the depositor
     * @param pendingActivations - number of validators that are pending for activation
     */
    struct ERC7201Storage {
        mapping(address nodeOperator => NodeOperatorBalance balance) nodeOperatorBalance;
        mapping(address nodeOperator => address guarantor) nodeOperatorGuarantor;
        mapping(address guarantor => uint256 claimableEther) guarantorClaimableEther;
        mapping(bytes validatorPubkey => ValidatorStatus validatorStatus) validatorStatus;
        mapping(address nodeOperator => address depositor) nodeOperatorDepositor;
        mapping(address stakingVault => uint256 number) pendingActivations;
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
     * @notice encodes parameters for method "topUpExistingValidators"
     * @param pubkey public key of the validator to top up. It should have the ACTIVATED status
     * @param amount amount of ether to deposit to this validator
     */
    struct ValidatorTopUp {
        bytes pubkey;
        uint256 amount;
    }

    uint8 public constant MIN_SUPPORTED_WC_VERSION = 0x01;
    uint8 public constant MAX_SUPPORTED_WC_VERSION = 0x02;

    /// @notice amount of ether that is predeposited with each validator
    uint128 public constant PREDEPOSIT_AMOUNT = 1 ether;

    /// @notice amount of ether to be deposited after the predeposit to activate the validator
    uint256 public constant ACTIVATION_DEPOSIT_AMOUNT = 31 ether;

    uint256 public constant MAX_TOPUP_AMOUNT = 2048 ether - ACTIVATION_DEPOSIT_AMOUNT - PREDEPOSIT_AMOUNT;

    //    Scheme of Validator Container Tree:
    //
    //                         Validator Container Root                      **DEPTH = 0
    //                                     │
    //                     ┌───────────────┴───────────────┐
    //                     │                               │
    //                 node                            proof[1]              **DEPTH = 1
    //                     │                               │
    //             ┌───────┴───────┐               ┌───────┴───────┐
    //             │               │               │               │
    //      PARENT TO PROVE      proof[0]        node             node       **DEPTH = 2
    //             │               │               │               │
    //       ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
    //       │           │   │           │   │           │   │           │
    //    [pubkeyRoot]  [wc]  [EB] [slashed] [AEE]      [AE] [EE]       [WE] **DEPTH = 3
    //    {.................}
    //             ↑
    //    data to be proven
    //
    // ```
    // bytes32 FAR_FUTURE_EPOCH_SSZ = 0xffffffffffffffff000000000000000000000000000000000000000000000000;
    // bytes32 hash = sha256(bytes.concat(
    //      sha256(bytes.concat(FAR_FUTURE_EPOCH_SSZ, FAR_FUTURE_EPOCH_SSZ)),
    //      sha256(bytes.concat(FAR_FUTURE_EPOCH_SSZ, FAR_FUTURE_EPOCH_SSZ))
    // ))
    // ```
    // Here we are relying on activation_eligibility_epoch being set first during the validator lifecycle
    // thus if activation_eligibility_epoch is FAR_FUTURE_EPOCH, all other epochs
    // (activation_epoch, exit_epoch, withdrawable_epoch) is also set to FAR_FUTURE_EPOCH
    // so we can prove them together
    bytes32 internal constant UNSET_VALIDATOR_EPOCHS_PROOF_NODE
        = 0x2c84ba62dc4e7011c24fb0878e3ef2245a9e2cf2cacbbaf2978a4efa47037283;

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
     * @param _pivotSlot slot of the fork that alters first validator GIndex
     * @dev if no fork changes are known,  _gIFirstValidatorAfterChange = _gIFirstValidator and _pivotSlot = 0
     */
    constructor(
        bytes4 _genesisForkVersion,
        GIndex _gIFirstValidator,
        GIndex _gIFirstValidatorAfterChange,
        uint64 _pivotSlot
    ) CLProofVerifier(_gIFirstValidator, _gIFirstValidatorAfterChange, _pivotSlot) {
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
     * @notice returns address of the depositor for the node operator (by default it is node operator itself)
     * @param _nodeOperator to check depositor for
     * @return address of depositor for the NO
     */
    function nodeOperatorDepositor(address _nodeOperator) external view returns (address) {
        return _depositorOf(_nodeOperator);
    }

    /**
     * @notice returns amount of ether refund that guarantor can claim
     * @param _guarantor address of the guarantor
     * @return amount of ether that guarantor will claim by calling `claimGuarantorRefund()`
     */
    function claimableRefund(address _guarantor) external view returns (uint256) {
        return _storage().guarantorClaimableEther[_guarantor];
    }

    /**
     * @notice returns PDG status of the validator by pubkey
     * @param _validatorPubkey to check status for
     * @return struct of ValidatorStatus
     */
    function validatorStatus(
        bytes calldata _validatorPubkey
    ) external view override returns (ValidatorStatus memory) {
        return _storage().validatorStatus[_validatorPubkey];
    }

    /**
     * @notice returns the number of validators in PREDEPOSITED and PROVEN states but not ACTIVATED yet
     * @param _vault staking vault address
     * @return the number of validators yet-to-be-activated
     */
    function pendingActivations(IStakingVault _vault) external view returns (uint256) {
        return _storage().pendingActivations[address(_vault)];
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
        BLS12_381.verifyDepositMessage(
            _deposit.pubkey,
            _deposit.signature,
            _deposit.amount,
            _depositsY,
            _withdrawalCredentials,
            DEPOSIT_DOMAIN
        );
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

            emit BalanceRefunded(msg.sender, prevGuarantor);
            emit GuarantorRefundAdded(prevGuarantor, msg.sender, refund);
        }

        $.nodeOperatorGuarantor.setOrReset(msg.sender, _newGuarantor);

        emit GuarantorSet(msg.sender, _newGuarantor, prevGuarantor);
    }

    /**
     * @notice sets the depositor for the NO
     * @param _newDepositor address of the depositor
     */
    function setNodeOperatorDepositor(address _newDepositor) external whenResumed {
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
    // * * * Validator Stage Transitions * * * //
    // * * * * * * * * * * * * * * * * * * * * //

    /**
     * @notice deposits `PREDEPOSIT_AMOUNT` from StakingVault to designated validators, locks up NO's balance
     *         and stage `ACTIVATION_DEPOSIT_AMOUNT` on StakingVault for later validator activation
     * @dev optionally accepts multiples of `PREDEPOSIT_AMOUNT` in `msg.value` to top up NO balance if NO is self-guarantor
     * @param _stakingVault address of the StakingVault to deposit validators from and use as withdrawal credentials
     * @param _deposits array of Deposit structs (amounts should be set to PREDEPOSIT_AMOUNT)
     * @param _depositsY array of uncompressed pubkey data to verify the signature for each deposit
     * @dev requires msg.sender to be designated depositor address
     * @dev transition NONE => PREDEPOSITED
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

        bytes32 withdrawalCredentials = _checkVaultWC(_stakingVault);

        ERC7201Storage storage $ = _storage();
        NodeOperatorBalance storage balance = $.nodeOperatorBalance[nodeOperator];

        uint256 totalDepositAmount = PREDEPOSIT_AMOUNT * _deposits.length;
        uint256 unlockedGuarantee = balance.total - balance.locked;

        if (unlockedGuarantee < totalDepositAmount) revert NotEnoughUnlocked(unlockedGuarantee, totalDepositAmount);

        balance.locked += uint128(totalDepositAmount);
        emit BalanceLocked(nodeOperator, balance.total, balance.locked);

        $.pendingActivations[address(_stakingVault)] += _deposits.length;

        mapping(bytes validatorPubkey => ValidatorStatus) storage validatorByPubkey = _storage().validatorStatus;

        for (uint256 i = 0; i < _deposits.length; i++) {
            IStakingVault.Deposit calldata _deposit = _deposits[i];
            ValidatorStatus storage validator = validatorByPubkey[_deposit.pubkey];

            if (validator.stage != ValidatorStage.NONE) revert ValidatorNotNew(_deposit.pubkey, validator.stage);
            if (_deposit.amount != PREDEPOSIT_AMOUNT) revert PredepositAmountInvalid(_deposit.pubkey, _deposit.amount);

            // checking BLS signature to avoid burning the predeposit
            verifyDepositMessage(_deposit, _depositsY[i], withdrawalCredentials);

            validatorByPubkey[_deposit.pubkey] = ValidatorStatus({
                stage: ValidatorStage.PREDEPOSITED,
                stakingVault: _stakingVault,
                nodeOperator: nodeOperator
            });

            _stakingVault.depositToBeaconChain(_deposit);

            emit ValidatorPreDeposited(_deposit.pubkey, nodeOperator, address(_stakingVault), withdrawalCredentials);
        }

        // staging 31 ETH to be able to activate the validator as it gets proved
        // reverts if there is no 31 ETH to stage
        _stakingVault.stage(ACTIVATION_DEPOSIT_AMOUNT * _deposits.length);
    }

    /**
     * @notice permissionless method to prove correct Withdrawal Credentials and activate validator if possible
     * @param _witness object containing validator pubkey, Merkle proof and timestamp for Beacon Block root child block
     * @dev will revert if proof is invalid or misformed or validator is not predeposited
     * @dev transition PREDEPOSITED => PROVEN [=> ACTIVATED]
     * @dev if activation is impossible, it can be done later by calling activateValidator() explicitly
     */
    function proveWCAndActivate(ValidatorWitness calldata _witness) external whenResumed {
        ValidatorStatus storage validator = _storage().validatorStatus[_witness.pubkey];

        if (validator.stage != ValidatorStage.PREDEPOSITED) {
            revert ValidatorNotPreDeposited(_witness.pubkey, validator.stage);
        }

        IStakingVault stakingVault = validator.stakingVault;
        bytes32 withdrawalCredentials = _checkVaultWC(stakingVault);
        address nodeOperator = validator.nodeOperator;

        _proveWC(_witness, stakingVault, withdrawalCredentials, nodeOperator);

        // activate validator if possible
        if (stakingVault.depositor() == address(this) && stakingVault.stagedBalance() >= ACTIVATION_DEPOSIT_AMOUNT) {
            validator.stage = ValidatorStage.ACTIVATED;
            _activateAndTopUpValidator(stakingVault, _witness.pubkey, 0, new bytes(96), withdrawalCredentials, nodeOperator);
        } else {
            // only if the vault is disconnected
            // because we check depositor and staged balance on connect and prevent them from changing until disconnected
            validator.stage = ValidatorStage.PROVEN;
        }
    }

    /**
     * @notice permissionless method to activate the proven validator depositing 31 ETH from the staged balance of StakingVault
     * @param _pubkey public key of the validator to activate
     * @dev transition PROVEN => ACTIVATED
     */
    function activateValidator(bytes calldata _pubkey) external whenResumed {
        ValidatorStatus storage validator = _storage().validatorStatus[_pubkey];

        if (validator.stage != ValidatorStage.PROVEN) {
            revert ValidatorNotProven(_pubkey, validator.stage);
        }

        IStakingVault stakingVault = validator.stakingVault;
        bytes32 withdrawalCredentials = _checkVaultWC(stakingVault);

        validator.stage = ValidatorStage.ACTIVATED;
        _activateAndTopUpValidator(
            stakingVault,
            _pubkey,
            0, /* top-up amount */
            new bytes(96),
            withdrawalCredentials,
            validator.nodeOperator
        );
    }

    /**
     * @notice proves the side-deposited validator's WC to allow depositing to it through PDG
     * @param _witness ValidatorWitness struct proving validator WC belongs to the staking vault
     * @param _stakingVault address of the StakingVault
     * @dev only callable by staking vault owner & only if validator stage is NONE
     * @dev reverts if the validator is not eligible for activation
     *      (to prevent validators that is not withdrawable by EIP-7002)
     * @dev transition NONE => ACTIVATED
     */
    function proveUnknownValidator(
        ValidatorWitness calldata _witness,
        IStakingVault _stakingVault
    ) external whenResumed {
        if (_stakingVault.owner() != msg.sender) revert NotStakingVaultOwner();

        // Forbid adding side-deposited validators that are not eligible for activation
        // because it won't be available for triggerable withdrawal without additional deposits
        // see CLProofValidator.sol to see why we check the 1st node in the proof array
        if (_witness.proof[1] == UNSET_VALIDATOR_EPOCHS_PROOF_NODE) {
            revert ValidatorNotEligibleForActivation(_witness.pubkey);
        }

        bytes32 withdrawalCredentials = _checkVaultWC(_stakingVault);

        _validatePubKeyWCProof(_witness, withdrawalCredentials);
        address nodeOperator = _stakingVault.nodeOperator();

        ValidatorStatus storage validator = _storage().validatorStatus[_witness.pubkey];

        if (validator.stage != ValidatorStage.NONE) {
            revert ValidatorNotNew(_witness.pubkey, validator.stage);
        }

        validator.stage = ValidatorStage.ACTIVATED;
        validator.stakingVault = _stakingVault;
        validator.nodeOperator = nodeOperator;

        emit ValidatorProven(_witness.pubkey, nodeOperator, address(_stakingVault), withdrawalCredentials);
        emit ValidatorActivated(_witness.pubkey, nodeOperator, address(_stakingVault), withdrawalCredentials);
    }

    /**
     * @notice permissionless method to prove that validator predeposit was frontrun
     *         and it have invalid withdrawal credentials and to compensate the vault from the locked guarantee balance
     * @param _witness object containing validator pubkey, Merkle proof and timestamp for Beacon Block root child block
     * @param _invalidWithdrawalCredentials withdrawal credentials that was used to frontrun the predeposit
     * @dev will revert if proof is invalid, validator is not predeposited or withdrawal credentials belong to correct vault
     * @dev validator WC versions mismatch (e.g 0x01 vs 0x02) will be treated as invalid WC
     * @dev transition PREDEPOSITED => COMPENSATED
     */
    function proveInvalidValidatorWC(
        ValidatorWitness calldata _witness,
        bytes32 _invalidWithdrawalCredentials
    ) external whenResumed {
        _validatePubKeyWCProof(_witness, _invalidWithdrawalCredentials);

        ERC7201Storage storage $ = _storage();
        ValidatorStatus storage validator = $.validatorStatus[_witness.pubkey];

        // validator state and WC incorrectness are enforced inside
        if (validator.stage != ValidatorStage.PREDEPOSITED) {
            revert ValidatorNotPreDeposited(_witness.pubkey, validator.stage);
        }

        IStakingVault stakingVault = validator.stakingVault;
        bytes32 vaultWithdrawalCredentials = _checkVaultWC(stakingVault);

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
        $.pendingActivations[address(stakingVault)] -= 1;

        // unlocking the staged amount if possible as we are not activating this validator
        if (stakingVault.depositor() == address(this) && stakingVault.stagedBalance() >= ACTIVATION_DEPOSIT_AMOUNT) {
            stakingVault.unstage(ACTIVATION_DEPOSIT_AMOUNT);
        }

        // transfer the compensation directly to the vault
        (bool success, ) = address(stakingVault).call{value: PREDEPOSIT_AMOUNT}("");
        if (!success) revert CompensateFailed();

        emit ValidatorCompensated(address(stakingVault), nodeOperator, _witness.pubkey, balance.total, balance.locked);
    }

    /**
     * @notice deposits ether to activated validators from respective staking vaults
     * @param _topUps array of ValidatorTopUp structs with pubkey and amounts
     * @dev only callable by the vault's depositor
     */
    function topUpExistingValidators(ValidatorTopUp[] calldata _topUps) external whenResumed {
        mapping(bytes => ValidatorStatus) storage validators = _storage().validatorStatus;
        bytes memory zeroSignature = new bytes(96);

        for (uint256 i = 0; i < _topUps.length; i++) {
            ValidatorTopUp calldata _topUp = _topUps[i];

            if (_topUp.amount > MAX_TOPUP_AMOUNT) revert InvalidTopUpAmount(_topUp.amount);

            ValidatorStatus storage validator = validators[_topUp.pubkey];

            if (_depositorOf(validator.nodeOperator) != msg.sender) {
                revert NotDepositor();
            }

            if (validator.stage != ValidatorStage.ACTIVATED) {
                revert ValidatorNotActivated(_topUp.pubkey, validator.stage);
            }

            IStakingVault vault = validator.stakingVault;
            bytes32 withdrawalCredentials = _checkVaultWC(vault);

            _topUpValidator(
                vault,
                _topUp.pubkey,
                _topUp.amount,
                zeroSignature,
                withdrawalCredentials
            );
        }
    }

    /**
     * @notice happy path shortcut for the node operator (or depositor) that allows:
     * - to prove validator's WC to unlock NO balance
     * - to activate the validator depositing ACTIVATION_DEPOSIT_AMOUNT from StakingVault staged balance
     * - to top up validator on top of ACTIVATION_DEPOSIT_AMOUNT
     * and do it for multiple validators at once
     * @param _witnesses array of ValidatorWitness structs to prove validators WCs
     * @param _amounts array of amounts of ether to deposit to proven validator on top of ACTIVATION_DEPOSIT_AMOUNT
     * @dev transition [PREDEPOSITED =>] [PROVEN =>] ACTIVATED
     * @dev if `_amount` != 0 requires msg.sender to be the depositor
     */
    function proveWCActivateAndTopUpValidators(
        ValidatorWitness[] calldata _witnesses,
        uint256[] calldata _amounts
    ) external whenResumed {
        if (_witnesses.length != _amounts.length) revert ArrayLengthsNotMatch();

        mapping(bytes => ValidatorStatus) storage validators = _storage().validatorStatus;
        bytes memory zeroSignature = new bytes(96);

        for (uint256 i = 0; i < _witnesses.length; i++) {
            bytes calldata _pubkey = _witnesses[i].pubkey;
            ValidatorStatus storage validator = validators[_pubkey];
            ValidatorStage stage = validator.stage;

            if (stage == ValidatorStage.NONE || stage == ValidatorStage.COMPENSATED) {
                revert InvalidValidatorStage(_pubkey, validator.stage);
            }

            if (_amounts[i] > MAX_TOPUP_AMOUNT) revert InvalidTopUpAmount(_amounts[i]);

            address nodeOperator = validator.nodeOperator;
            if (_amounts[i] > 0 && msg.sender != _depositorOf(nodeOperator)) {
                revert NotDepositor();
            }

            IStakingVault vault = validator.stakingVault;
            bytes32 withdrawalCredentials = _checkVaultWC(vault);

            if (stage == ValidatorStage.PREDEPOSITED) {
                _proveWC(_witnesses[i], vault, withdrawalCredentials, nodeOperator);
                stage = ValidatorStage.PROVEN;
            }

            if (stage == ValidatorStage.PROVEN) {
                validator.stage = ValidatorStage.ACTIVATED;
                _activateAndTopUpValidator(
                    vault,
                    _pubkey,
                    _amounts[i],
                    zeroSignature,
                    withdrawalCredentials,
                    nodeOperator
                );
            } else if (stage == ValidatorStage.ACTIVATED && _amounts[i] > 0) {
                _topUpValidator(
                    vault,
                    _pubkey,
                    _amounts[i],
                    zeroSignature,
                    withdrawalCredentials
                );
            }
        }
    }


    // * * * * * * * * * * * * * * * * * * * * //
    // * * * * * Internal Functions * * * * *  //
    // * * * * * * * * * * * * * * * * * * * * //

    function _proveWC(
        ValidatorWitness calldata _witness,
        IStakingVault _vault,
        bytes32 _withdrawalCredentials,
        address _nodeOperator
    ) internal {
        _validatePubKeyWCProof(_witness, _withdrawalCredentials);

        NodeOperatorBalance storage balance = _storage().nodeOperatorBalance[_nodeOperator];
        balance.locked -= PREDEPOSIT_AMOUNT;

        emit BalanceUnlocked(_nodeOperator, balance.total, balance.locked);
        emit ValidatorProven(_witness.pubkey, _nodeOperator, address(_vault), _withdrawalCredentials);
    }

    function _activateAndTopUpValidator(
        IStakingVault _stakingVault,
        bytes calldata _pubkey,
        uint256 _additionalAmount,
        bytes memory zeroSignature,
        bytes32 _withdrawalCredentials,
        address _nodeOperator
    ) internal {
        _storage().pendingActivations[address(_stakingVault)] -= 1;
        uint256 depositAmount = ACTIVATION_DEPOSIT_AMOUNT + _additionalAmount;

        IStakingVault.Deposit memory deposit = IStakingVault.Deposit({
            pubkey: _pubkey,
            signature: zeroSignature,
            amount: depositAmount,
            depositDataRoot: _depositDataRootWithZeroSig(_pubkey, depositAmount, _withdrawalCredentials)
        });

        _stakingVault.depositFromStaged(deposit, _additionalAmount);

        emit ValidatorActivated(_pubkey, _nodeOperator, address(_stakingVault), _withdrawalCredentials);
    }

    function _topUpValidator(
        IStakingVault _stakingVault,
        bytes calldata _pubkey,
        uint256 _amount,
        bytes memory zeroSignature,
        bytes32 _withdrawalCredentials
    ) internal {
        IStakingVault.Deposit memory deposit = IStakingVault.Deposit({
            pubkey: _pubkey,
            signature: zeroSignature,
            amount: _amount,
            depositDataRoot: _depositDataRootWithZeroSig(_pubkey, _amount, _withdrawalCredentials)
        });

        _stakingVault.depositToBeaconChain(deposit);
    }

    /// @dev the edge case deposit data root for zero signature and 31 ETH amount
    function _depositDataRootWithZeroSig(
        bytes calldata _pubkey,
        uint256 amount,
        bytes32 _withdrawalCredentials
    ) internal pure returns (bytes32) {
        bytes32 pubkeyRoot = sha256(bytes.concat(_pubkey, bytes16(0)));

        // sha256(sha256(0x0)|sha256(0x0))
        bytes32 zeroSignatureRoot = 0xdb56114e00fdd4c1f85c892bf35ac9a89289aaecb1ebd0a96cde606a748b5d71;

        bytes memory amountLE64 = _toLittleEndian64(uint64(amount / 1 gwei));

        return sha256(bytes.concat(
            sha256(bytes.concat(pubkeyRoot, _withdrawalCredentials)),
            sha256(bytes.concat(amountLE64, bytes24(0), zeroSignatureRoot))
        ));
    }

    function _toLittleEndian64(uint64 value) internal pure returns (bytes memory ret) {
        ret = new bytes(8);
        bytes8 bytesValue = bytes8(value);
        // Byteswapping during copying to bytes.
        ret[0] = bytesValue[7];
        ret[1] = bytesValue[6];
        ret[2] = bytesValue[5];
        ret[3] = bytesValue[4];
        ret[4] = bytesValue[3];
        ret[5] = bytesValue[2];
        ret[6] = bytesValue[1];
        ret[7] = bytesValue[0];
    }

    function _topUpNodeOperatorBalance(address _nodeOperator) internal onlyGuarantorOf(_nodeOperator) {
        uint128 amount = uint128(msg.value);

        // _nodeOperator != address(0) is enforced by onlyGuarantorOf()
        if (amount == 0) revert ZeroArgument("msg.value");
        if (amount % PREDEPOSIT_AMOUNT != 0) revert ValueNotMultipleOfPredepositAmount(amount);

        _storage().nodeOperatorBalance[_nodeOperator].total += amount;

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

    function _checkVaultWC(IStakingVault _stakingVault) internal view returns (bytes32 wc) {
        wc = _stakingVault.withdrawalCredentials();
        _validateWC(address(_stakingVault), wc);
    }

    /// @notice validates that WC belong to the vault
    function _validateWC(address _stakingVault, bytes32 _withdrawalCredentials) internal pure {
        uint8 version = uint8(_withdrawalCredentials[0]);
        address wcAddress = address(uint160(uint256(_withdrawalCredentials)));

        if (version < MIN_SUPPORTED_WC_VERSION || version > MAX_SUPPORTED_WC_VERSION) {
            revert WithdrawalCredentialsInvalidVersion(version);
        }

        // extract zero bytes between version and address in WC
        if (((_withdrawalCredentials << 8) >> 168) != bytes32(0))
            revert WithdrawalCredentialsMisformed(_withdrawalCredentials);

        if (_stakingVault != wcAddress) {
            revert WithdrawalCredentialsMismatch(_stakingVault, wcAddress);
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
    event ValidatorActivated(
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
    error ValidatorNotActivated(bytes validatorPubkey, ValidatorStage stage);
    error ValidatorNotProven(bytes validatorPubkey, ValidatorStage stage);
    error InvalidTopUpAmount(uint256 amount);
    error InvalidValidatorStage(bytes validatorPubkey, ValidatorStage stage);

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
    error ArrayLengthsNotMatch();
}
