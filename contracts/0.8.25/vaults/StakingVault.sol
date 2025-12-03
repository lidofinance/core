// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/Ownable2StepUpgradeable.sol";
import {TriggerableWithdrawals} from "contracts/common/lib/TriggerableWithdrawals.sol";
import {IDepositContract} from "contracts/common/interfaces/IDepositContract.sol";

import {PinnedBeaconUtils} from "./lib/PinnedBeaconUtils.sol";
import {RecoverTokens} from "./lib/RecoverTokens.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

/**
 * @title StakingVault
 * @author Lido
 * @notice
 *
 * StakingVault is a contract which is designed to be used as withdrawal credentials
 * to stake ETH with a designated node operator, while being able to mint stETH.
 *
 * The StakingVault can be used as a backing for minting new stETH through integration with the VaultHub.
 * When minting stETH backed by the StakingVault, the VaultHub designates a portion of the StakingVault's
 * total value as locked, which cannot be withdrawn by the owner. This locked portion represents the
 * collateral for the minted stETH.
 *
 * PinnedBeaconProxy
 * The contract is designed as an extended beacon proxy implementation, allowing individual StakingVault instances
 * to be ossified (pinned) to prevent future upgrades. The implementation is petrified (non-initializable)
 * and contains immutable references to the beacon chain deposit contract.
 */
contract StakingVault is IStakingVault, Ownable2StepUpgradeable {
    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │            CONSTANTS                         │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @notice Version of the contract on the implementation
     *         The implementation is petrified to this version
     */
    uint64 private constant _VERSION = 1;

    /**
     * @notice The type of withdrawal credentials for the validators deposited from this `StakingVault`.
     */
    uint256 private constant WC_0X02_PREFIX = 0x02 << 248;

    /**
     * @notice The length of the public key in bytes
     */
    uint256 private constant PUBLIC_KEY_LENGTH = 48;

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         `keccak256(abi.encode(uint256(keccak256("Lido.Vaults.StakingVault")) - 1)) & ~bytes32(uint256(0xff))`
     */
    bytes32 private constant ERC7201_SLOT = 0x2ec50241a851d8d3fea472e7057288d4603f7a7f78e6d18a9c12cad84552b100;

    /**
     * @notice Address of `BeaconChainDepositContract`
     *         Set immutably in the constructor to avoid storage costs
     */
    IDepositContract public immutable DEPOSIT_CONTRACT;

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │            STATE                             │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @dev ERC-7201: Namespaced Storage Layout
     * @custom:storage-location erc7201:Lido.Vaults.StakingVault
     */
    struct Storage {
        // 1st slot
        address nodeOperator;
        // 2nd slot
        address depositor;
        bool beaconChainDepositsPaused;
        // 3rd slot
        uint256 stagedBalance;
    }

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │            INITIALIZATION                    │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @dev Fixes the deposit contract address. Disables reinitialization of the implementation.
     */
    constructor(address _beaconChainDepositContract) {
        if (_beaconChainDepositContract == address(0)) revert ZeroArgument("_beaconChainDepositContract");
        DEPOSIT_CONTRACT = IDepositContract(_beaconChainDepositContract);
        _disableInitializers();
    }

    /**
     * @notice Initializes `StakingVault` with an owner, node operator, and depositor
     * @param _owner Address of the owner
     * @param _nodeOperator Address of the node operator
     * @param _depositor Address of the depositor
     */
    function initialize(address _owner, address _nodeOperator, address _depositor) external initializer {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        __Ownable_init(_owner);
        __Ownable2Step_init();
        _setDepositor(_depositor);
        _storage().nodeOperator = _nodeOperator;

        emit NodeOperatorSet(_nodeOperator);
    }

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │            VIEW FUNCTIONS                    │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @notice Returns the highest version that has been initialized as uint64
     */
    function getInitializedVersion() external view returns (uint64) {
        return _getInitializedVersion();
    }

    /**
     * @notice Returns the version of the contract as uint64
     */
    function version() external pure returns (uint64) {
        return _VERSION;
    }

    /**
     * @notice Returns owner of the contract
     * @dev Fixes solidity interface inference
     */
    function owner() public view override(IStakingVault, OwnableUpgradeable) returns (address) {
        return OwnableUpgradeable.owner();
    }

    /**
     * @notice Returns the pending owner of the contract
     * @dev Fixes solidity interface inference
     */
    function pendingOwner() public view override(IStakingVault, Ownable2StepUpgradeable) returns (address) {
        return Ownable2StepUpgradeable.pendingOwner();
    }

    /**
     * @notice Returns the node operator address
     * @return Address of the node operator
     */
    function nodeOperator() public view returns (address) {
        return _storage().nodeOperator;
    }

    /**
     * @notice Returns the depositor address
     * @return Address of the depositor
     */
    function depositor() public view returns (address) {
        return _storage().depositor;
    }

    /**
     * @notice Returns the 0x02-type withdrawal credentials for the validators deposited from this `StakingVault`
     *         All consensus layer rewards are sent to this contract. Only 0x02-type withdrawal credentials are supported
     * @return Bytes32 value of the withdrawal credentials
     */
    function withdrawalCredentials() public view returns (bytes32) {
        return bytes32(WC_0X02_PREFIX | uint160(address(this)));
    }

    /**
     * @notice Calculates the total fee required for EIP-7002 withdrawals for a given number of validator keys
     * @param _numberOfKeys Number of validators' public keys
     * @return Total fee amount to pass as `msg.value` (wei)
     * @dev    The fee may change from block to block
     */
    function calculateValidatorWithdrawalFee(uint256 _numberOfKeys) external view returns (uint256) {
        return _numberOfKeys * TriggerableWithdrawals.getWithdrawalRequestFee();
    }

    /**
     * @notice Calculates the balance that is available for withdrawal (does not account the balances staged for activations)
     * @return amount of ether available for withdrawal in Wei
     */
    function availableBalance() public view returns (uint256) {
        return address(this).balance - _storage().stagedBalance;
    }

    /**
     * @notice Returns the amount of ether on the balance that was staged by depositor for validator activations
     * @return the amount of staged ether in Wei
     */
    function stagedBalance() external view returns (uint256) {
        return _storage().stagedBalance;
    }

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │            BALANCE OPERATIONS                │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @dev Transfers ether directly to the `StakingVault`
     */
    receive() external payable {}

    /**
     * @notice Funds the `StakingVault` with ether
     */
    function fund() external payable onlyOwner {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        emit EtherFunded(msg.value);
    }

    /**
     * @notice Withdraws ether from the vault
     * @param _recipient Address to send the ether to
     * @param _ether Amount of ether to withdraw
     */
    function withdraw(address _recipient, uint256 _ether) external onlyOwner {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > availableBalance()) revert InsufficientBalance(availableBalance(), _ether);

        (bool success, ) = _recipient.call{value: _ether}("");
        if (!success) revert TransferFailed(_recipient, _ether);

        emit EtherWithdrawn(_recipient, _ether);
    }

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │            BEACON CHAIN DEPOSITS             │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @notice Returns whether the beacon chain deposits are paused
     */
    function beaconChainDepositsPaused() external view returns (bool) {
        return _storage().beaconChainDepositsPaused;
    }

    /**
     * @notice Pauses deposits to beacon chain
     */
    function pauseBeaconChainDeposits() external onlyOwner {
        Storage storage $ = _storage();
        if ($.beaconChainDepositsPaused) revert BeaconChainDepositsAlreadyPaused();

        $.beaconChainDepositsPaused = true;

        emit BeaconChainDepositsPaused();
    }

    /**
     * @notice Resumes deposits to beacon chain
     */
    function resumeBeaconChainDeposits() external onlyOwner {
        Storage storage $ = _storage();
        if (!$.beaconChainDepositsPaused) revert BeaconChainDepositsAlreadyResumed();

        $.beaconChainDepositsPaused = false;

        emit BeaconChainDepositsResumed();
    }

    /**
     * @notice Performs deposit to the beacon chain using ether from available balance
     * @param _deposit validator deposit struct
     */
    function depositToBeaconChain(Deposit calldata _deposit) external onlyDepositor whenDepositsNotPaused {
        _depositToBeaconChain(_deposit, bytes.concat(withdrawalCredentials()));
    }

    /**
     * @notice Puts aside some ether from the balance to deposit it later
     * @param _ether the amount of ether to stage in Wei
     */
    function stage(uint256 _ether) external onlyDepositor whenDepositsNotPaused {
        if (_ether == 0) revert ZeroArgument("_ether");
        uint256 balance = availableBalance();
        if (balance < _ether) revert InsufficientBalance(balance, _ether);

        _storage().stagedBalance += _ether;

        emit EtherStaged(_ether);
    }

    /**
     * @notice Returns the ether staged for deposits back to available balance
     * @param _ether the amount of ether to remove from stage in Wei
     */
    function unstage(uint256 _ether) public onlyDepositor {
        if (_ether == 0) revert ZeroArgument("_ether");
        uint256 staged = _storage().stagedBalance;
        if (staged < _ether) revert InsufficientStaged(staged, _ether);

        _storage().stagedBalance = staged - _ether;
        emit EtherUnstaged(_ether);
    }

    /**
     * @notice Performs deposits to the beacon chain using the staged and available ether.
     * @param _deposit struct
     * @param _additionalAmount amount of ether that should be taken from available balance for this deposit
     * @dev NB! this deposit is not affected by pause if _additionalAmount == 0
     */
    function depositFromStaged(Deposit calldata _deposit, uint256 _additionalAmount) external onlyDepositor {
        if (_additionalAmount > 0) {
            if (_storage().beaconChainDepositsPaused) revert BeaconChainDepositsOnPause();
        }
        unstage(_deposit.amount - _additionalAmount);

        _depositToBeaconChain(_deposit, bytes.concat(withdrawalCredentials()));
    }

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │          BEACON CHAIN WITHDRAWALS            │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @notice Requests node operator to exit validators from the beacon chain
     *         It does not directly trigger exits - node operators must monitor for these events and handle the exits
     * @param _pubkeys Concatenated validator public keys, each 48 bytes long
     */
    function requestValidatorExit(bytes calldata _pubkeys) external onlyOwner {
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert InvalidPubkeysLength();
        }

        uint256 keysCount = _pubkeys.length / PUBLIC_KEY_LENGTH;
        for (uint256 i = 0; i < keysCount; i++) {
            bytes memory pubkey = _pubkeys[i * PUBLIC_KEY_LENGTH:(i + 1) * PUBLIC_KEY_LENGTH];
            emit ValidatorExitRequested(/* indexed */ pubkey, pubkey);
        }
    }

    /**
     * @notice Triggers validator withdrawals from the beacon chain using EIP-7002 triggerable withdrawals.
     *         A general-purpose function for withdrawing ether from the beacon chain by the owner.
     *         If the amount of ether to withdraw is not specified, the full balance of the validator is withdrawn.
     * @param _pubkeys Concatenated validators public keys, each 48 bytes long
     * @param _amountsInGwei Amounts of Gwei to withdraw. If array is empty or amount value is zero, triggers full withdrawals.
     * @param _excessRefundRecipient Address to receive any excess withdrawal fee
     * @dev    The caller must provide sufficient fee via msg.value to cover the withdrawal request costs
     * @dev    You can use `calculateValidatorWithdrawalFee` to calculate the fee but it's accurate only for the block
     *         it's called. The fee may change from block to block, so it's recommended to send fee with some surplus.
     *         The excess amount will be refunded.
     */
    function triggerValidatorWithdrawals(
        bytes calldata _pubkeys,
        uint64[] calldata _amountsInGwei,
        address _excessRefundRecipient
    ) external payable onlyOwner {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) revert InvalidPubkeysLength();
        if (_excessRefundRecipient == address(0)) revert ZeroArgument("_excessRefundRecipient");

        uint256 feePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        uint256 totalFee = (_pubkeys.length / PUBLIC_KEY_LENGTH) * feePerRequest;
        if (msg.value < totalFee) revert InsufficientValidatorWithdrawalFee(msg.value, totalFee);

        // If amounts array is empty, trigger full withdrawals, otherwise use amount-driven withdrawal types
        if (_amountsInGwei.length == 0) {
            TriggerableWithdrawals.addFullWithdrawalRequests(_pubkeys, feePerRequest);
        } else {
            TriggerableWithdrawals.addWithdrawalRequests(_pubkeys, _amountsInGwei, feePerRequest);
        }

        uint256 excess = msg.value - totalFee;
        if (excess > 0) {
            (bool success, ) = _excessRefundRecipient.call{value: excess}("");
            if (!success) revert TransferFailed(_excessRefundRecipient, excess);
        }

        emit ValidatorWithdrawalsTriggered(_pubkeys, _amountsInGwei, excess, _excessRefundRecipient);
    }

    /**
     * @notice Triggers EIP-7002 validator exits by the node operator.
     *         Because the node operator cannot ensure that all the associated validators are under control,
     *         the node operator has the ability to forcefully eject validators.
     * @param _pubkeys Concatenated validators public keys, each 48 bytes long
     * @param _refundRecipient Address to receive the fee refund, if zero, refunds go to msg.sender
     * @dev    The caller must provide sufficient fee via msg.value to cover the withdrawal request costs
     * @dev    Use `calculateValidatorWithdrawalFee` to calculate the fee
     */
    function ejectValidators(bytes calldata _pubkeys, address _refundRecipient) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) revert InvalidPubkeysLength();
        if (msg.sender != _storage().nodeOperator) revert SenderNotNodeOperator();

        // If the refund recipient is not set, use the sender as the refund recipient
        if (_refundRecipient == address(0)) _refundRecipient = msg.sender;

        uint256 feePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        uint256 totalFee = (_pubkeys.length / PUBLIC_KEY_LENGTH) * feePerRequest;
        if (msg.value < totalFee) revert InsufficientValidatorWithdrawalFee(msg.value, totalFee);

        TriggerableWithdrawals.addFullWithdrawalRequests(_pubkeys, feePerRequest);

        uint256 excess = msg.value - totalFee;
        if (excess > 0) {
            (bool success, ) = _refundRecipient.call{value: excess}("");
            if (!success) revert TransferFailed(_refundRecipient, excess);
        }

        emit ValidatorEjectionsTriggered(_pubkeys, excess, _refundRecipient);
    }

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │           ADMINISTRATIVE FUNCTIONS           │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @notice Accepts the pending owner
     * @dev Fixes solidity interface inference
     * @dev Can only be called by the pending owner
     */
    function acceptOwnership() public override(IStakingVault, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable.acceptOwnership();
    }

    /**
     * @notice Transfers the ownership of the contract to a new owner
     * @param _newOwner Address of the new owner
     * @dev Fixes solidity interface inference
     * @dev Can only be called by the owner
     */
    function transferOwnership(address _newOwner) public override(IStakingVault, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable.transferOwnership(_newOwner);
    }

    /**
     * @notice Override the OwnableUpgradeable function to revert
     */
    function renounceOwnership() public view onlyOwner override(OwnableUpgradeable) {
        revert RenouncementNotAllowed();
    }

    /**
     * @notice Sets the depositor address
     * @param _depositor Address of the new depositor
     */
    function setDepositor(address _depositor) external onlyOwner {
        _setDepositor(_depositor);
    }

    /**
     * @notice Ossifies the current implementation. WARNING: This operation is irreversible.
     * @dev vault can't be connected to the hub after ossification
     */
    function ossify() external onlyOwner {
        PinnedBeaconUtils.ossify();
    }


    /**
     * @notice collects ERC20 tokens from the Staking Vault to the recipient
     * @param _token Address of the token to recover
     * @param _recipient Address of collection recipient
     * @param _amount Amount of tokens to recover
     */
    function collectERC20(
        address _token,
        address _recipient,
        uint256 _amount
    ) external onlyOwner {
        if (_token == address(0)) revert ZeroArgument("_token");
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_amount == 0) revert ZeroArgument("_amount");
        if (_token == RecoverTokens.ETH) {
            revert EthCollectionNotAllowed();
        }

        RecoverTokens._recoverERC20(_token, _recipient, _amount);
    }

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │            INTERNAL FUNCTIONS                │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @dev Returns the storage struct for the ERC-7201 namespace
     * @return $ storage struct for the ERC-7201 namespace
     */
    function _storage() private pure returns (Storage storage $) {
        assembly {
            $.slot := ERC7201_SLOT
        }
    }

    function _depositToBeaconChain(Deposit calldata _deposit, bytes memory _withdrawalCredentials) internal {
        uint256 balance = availableBalance();
        if (_deposit.amount > balance) revert InsufficientBalance(balance, _deposit.amount);

        DEPOSIT_CONTRACT.deposit{value: _deposit.amount}(
            _deposit.pubkey,
            _withdrawalCredentials,
            _deposit.signature,
            _deposit.depositDataRoot
        );
    }

    /**
     * @dev Sets the depositor address in the `StakingVault`
     * @param _depositor Address of the new depositor
     */
    function _setDepositor(address _depositor) internal {
        if (_depositor == address(0)) revert ZeroArgument("_depositor");
        if (_depositor == _storage().depositor) revert NewDepositorSameAsPrevious();
        address previousDepositor = _storage().depositor;
        _storage().depositor = _depositor;
        emit DepositorSet(previousDepositor, _depositor);
    }

    modifier whenDepositsNotPaused {
        if (_storage().beaconChainDepositsPaused) revert BeaconChainDepositsOnPause();
        _;
    }

    modifier onlyDepositor {
        if (_storage().depositor != msg.sender) revert SenderNotDepositor();
        _;
    }

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │                EVENTS                        │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @notice Emitted when ether is funded to the `StakingVault`
     * @param amount Amount of ether funded
     */
    event EtherFunded(uint256 amount);

    /**
     * @notice Emitted when ether is withdrawn from the `StakingVault`
     * @param recipient Address that received the ether
     * @param amount Amount of ether withdrawn
     */
    event EtherWithdrawn(address indexed recipient, uint256 amount);

    /**
     * @notice Emitted when the node operator is set in the `StakingVault`
     * @param nodeOperator Address of the node operator
     */
    event NodeOperatorSet(address indexed nodeOperator);

    /**
     * @notice Emitted when the depositor is set in the `StakingVault`
     * @param previousDepositor Previous depositor
     * @param newDepositor New depositor
     */
    event DepositorSet(address indexed previousDepositor, address indexed newDepositor);

    /**
     * @notice Emitted when the beacon chain deposits are paused
     */
    event BeaconChainDepositsPaused();

    /**
     * @notice Emitted when the beacon chain deposits are resumed
     */
    event BeaconChainDepositsResumed();

    /**
     * @notice Emitted when vault owner requests node operator to exit validators from the beacon chain
     * @param pubkey Indexed public key of the validator to exit
     * @param pubkeyRaw Raw public key of the validator to exit
     * @dev    Signals to node operators that they should exit this validator from the beacon chain
     */
    event ValidatorExitRequested(bytes indexed pubkey, bytes pubkeyRaw);

    /**
     * @notice Emitted when validator withdrawals are requested via EIP-7002
     * @param pubkeys Concatenated public keys of the validators to withdraw
     * @param amountsInGwei Amounts of Gwei to withdraw per validator
     * @param refundRecipient Address to receive any excess withdrawal fee
     * @param excess Amount of excess fee refunded to recipient
     */
    event ValidatorWithdrawalsTriggered(
        bytes pubkeys,
        uint64[] amountsInGwei,
        uint256 excess,
        address indexed refundRecipient
    );

    /**
     * @notice Emitted when validator ejections are triggered
     * @param pubkeys Concatenated public keys of the validators to eject
     * @param excess Amount of excess fee refunded to recipient
     * @param refundRecipient Address to receive any excess withdrawal fee
     */
    event ValidatorEjectionsTriggered(
        bytes pubkeys,
        uint256 excess,
        address indexed refundRecipient
    );

    /**
     * Emitted when ether is put aside from available balance
     * @param amount Amount of ether being staged in Wei
     */
    event EtherStaged(uint256 amount);

    /**
     * Emitted when ether is returned back to available balance
     * @param amount amount of ether being unstaged in Wei
     */
    event EtherUnstaged(uint256 amount);

    /*
     * ╔══════════════════════════════════════════════════╗
     * ║ ┌──────────────────────────────────────────────┐ ║
     * ║ │                ERRORS                        │ ║
     * ║ └──────────────────────────────────────────────┘ ║
     * ╚══════════════════════════════════════════════════╝
     */

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when the balance of the vault is insufficient
     * @param _balance Balance of the vault
     * @param _required Amount of ether required
     */
    error InsufficientBalance(uint256 _balance, uint256 _required);

    /**
     * @notice Thrown when the amount of ether in stage is not sufficient
     * @param _staged Stashed amount on the vault
     * @param _requested Amount of ether requested to unstage
     */
    error InsufficientStaged(uint256 _staged, uint256 _requested);

    /**
     * @notice Thrown when the transfer of ether to a recipient fails
     * @param recipient Address that was supposed to receive the transfer
     * @param amount Amount that failed to transfer
     */
    error TransferFailed(address recipient, uint256 amount);

    /**
     * @notice Thrown when the new depositor is the same as the previous depositor
     */
    error NewDepositorSameAsPrevious();

    /**
     * @notice Thrown when the beacon chain deposits are already paused
     */
    error BeaconChainDepositsAlreadyPaused();

    /**
     * @notice Thrown when the beacon chain deposits are already resumed
     */
    error BeaconChainDepositsAlreadyResumed();

    /**
     * @notice Thrown when the beacon chain deposits are on pause
     */
    error BeaconChainDepositsOnPause();

    /**
     * @notice Thrown when the sender is not set as the depositor
     */
    error SenderNotDepositor();

    /**
     * @notice Thrown when the sender is not the node operator
     */
    error SenderNotNodeOperator();

    /**
     * @notice Thrown when the length of the validator public keys is invalid
     */
    error InvalidPubkeysLength();

    /**
     * @notice Thrown when the validator withdrawal fee is insufficient
     * @param _passed Amount of ether passed to the function
     * @param _required Amount of ether required to cover the fee
     */
    error InsufficientValidatorWithdrawalFee(uint256 _passed, uint256 _required);

    /**
     * @notice thrown when trying to recover ETH (via EIP-7528 address) using collectERC20
     */
    error EthCollectionNotAllowed();

    /**
     * @notice thrown when trying to renounce ownership
     */
    error RenouncementNotAllowed();
}
