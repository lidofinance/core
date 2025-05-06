// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {TriggerableWithdrawals} from "contracts/common/lib/TriggerableWithdrawals.sol";

import {VaultHub} from "./VaultHub.sol";
import {PinnedBeaconUtils} from "./lib/PinnedBeaconUtils.sol";

import {IDepositContract} from "../interfaces/IDepositContract.sol";
import {IStakingVault, StakingVaultDeposit} from "./interfaces/IStakingVault.sol";

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
 * Access Control:
 * - Owner:
 *   - `fund()`
 *   - `withdraw()`
 *   - `rebalance()`
 *   - `lock()`
 *   - `pauseBeaconChainDeposits()`
 *   - `resumeBeaconChainDeposits()`
 *   - `requestValidatorExit()`
 *   - `triggerValidatorWithdrawal()`
 *   - `authorizeLidoVaultHub()`
 *   - `deauthorizeLidoVaultHub()`
 *   - `ossifyStakingVault()`
 *   - `setDepositor()`
 *   - `resetLocked()`
 * - Operator:
 *   - `triggerValidatorWithdrawal()`
 * - Depositor:
 *   - `depositToBeaconChain()`
 * - VaultHub:
 *   - `report()`
 *   - `rebalance()`
 *   - `triggerValidatorWithdrawal()`
 * - Anyone:
 *   - Can send ETH directly to the vault (treated as rewards)
 *
 * PinnedBeaconProxy
 * The contract is designed as an extended beacon proxy implementation, allowing individual StakingVault instances
 * to be ossified (pinned) to prevent future upgrades. The implementation is petrified (non-initializable)
 * and contains immutable references to the beacon chain deposit contract.
 */
contract StakingVault is IStakingVault, OwnableUpgradeable {
    IDepositContract public immutable DEPOSIT_CONTRACT;

    struct ERC7201Storage {
        address nodeOperator;
        bool beaconChainDepositsPaused;
    }

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
    uint256 public constant PUBLIC_KEY_LENGTH = 48;

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         `keccak256(abi.encode(uint256(keccak256("Lido.Vaults.StakingVault")) - 1)) & ~bytes32(uint256(0xff))`
     */
    bytes32 private constant ERC7201_STORAGE_LOCATION =
        0x2ec50241a851d8d3fea472e7057288d4603f7a7f78e6d18a9c12cad84552b100;

    /**
     * @notice Constructs the implementation of `StakingVault`
     */
    constructor(address _depositContract) {
        DEPOSIT_CONTRACT = IDepositContract(_depositContract);

        // Prevents reinitialization of the implementation
        _disableInitializers();
    }

    /**
     * @notice Initializes `StakingVault` with an owner, node operator, and optional parameters
     * @param _owner Address that will own the vault
     */
    function initialize(address _owner, address _nodeOperator) external initializer {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        __Ownable_init(_owner);
        _storage().nodeOperator = _nodeOperator;

        emit NodeOperatorSet(_nodeOperator);
    }

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
     * @notice returns owner of the contract
     * @dev fixes solidity interface inference
     */
    function owner() public view override(IStakingVault, OwnableUpgradeable) returns (address) {
        return OwnableUpgradeable.owner();
    }

    function nodeOperator() public view returns (address) {
        return _storage().nodeOperator;
    }

    /**
     * @notice Returns true if the vault is ossified
     * @return True if the vault is ossified, false otherwise
     */
    function isOssified() public view returns (bool) {
        return PinnedBeaconUtils.ossified();
    }

    /**
     * @notice Returns the 0x02-type withdrawal credentials for the validators deposited from this `StakingVault`
     *         All consensus layer rewards are sent to this contract. Only 0x02-type withdrawal credentials are supported
     */
    function withdrawalCredentials() public view returns (bytes32) {
        return bytes32(WC_0X02_PREFIX | uint160(address(this)));
    }

    /**
     * @notice Calculates the total withdrawal fee required for given number of validator keys
     * @param _numberOfKeys Number of validators' public keys
     * @return Total fee amount to pass as `msg.value` (wei)
     * @dev    The fee is only valid for the requests made in the same block
     */
    function calculateValidatorWithdrawalFee(uint256 _numberOfKeys) external view returns (uint256) {
        if (_numberOfKeys == 0) revert ZeroArgument("_numberOfKeys");

        return _numberOfKeys * TriggerableWithdrawals.getWithdrawalRequestFee();
    }

    receive() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        emit EtherReceived(msg.sender, msg.value);
    }

    function withdraw(address _recipient, uint256 _ether) external onlyOwner {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");

        (bool success, ) = _recipient.call{value: _ether}("");
        if (!success) revert TransferFailed(_recipient, _ether);

        emit EtherWithdrawn(msg.sender, _recipient, _ether);
    }

    /**
     * @notice Ossifies the current implementation. WARNING: This operation is irreversible,
     *         once ossified, the vault cannot be upgraded or attached to VaultHub.
     * @dev Can only be called by the owner.
     *      Pins the current vault implementation to prevent further upgrades.
     *      Emits an event `PinnedImplementationUpdated` with the current implementation address.
     * @dev Reverts if already ossified.
     * @dev Reverts if vaultHub is authorized at the vault
     */
    function ossify() external onlyOwner {
        if (isOssified()) revert AlreadyOssified();

        PinnedBeaconUtils.ossify();
    }

    function pauseBeaconChainDeposits() external onlyOwner {
        ERC7201Storage storage $ = _storage();

        if ($.beaconChainDepositsPaused) {
            revert BeaconChainDepositsResumeExpected();
        }

        $.beaconChainDepositsPaused = true;

        emit BeaconChainDepositsPaused();
    }

    /**
     * @notice Resumes deposits to beacon chain
     * @dev    Can only be called by the vault owner
     */
    function resumeBeaconChainDeposits() external onlyOwner {
        ERC7201Storage storage $ = _storage();
        if (!$.beaconChainDepositsPaused) {
            revert BeaconChainDepositsPauseExpected();
        }

        $.beaconChainDepositsPaused = false;

        emit BeaconChainDepositsResumed();
    }

    function depositToBeaconChain(StakingVaultDeposit[] calldata _deposits) external onlyOwner {
        if (_deposits.length == 0) revert ZeroArgument("_deposits");
        if (_storage().beaconChainDepositsPaused) revert BeaconChainDepositsResumeExpected();

        uint256 numberOfDeposits = _deposits.length;

        uint256 totalAmount;
        for (uint256 i = 0; i < numberOfDeposits; i++) {
            totalAmount += _deposits[i].amount;
        }

        uint256 contractBalance = address(this).balance;
        if (totalAmount > contractBalance) revert InsufficientBalance(contractBalance, totalAmount);

        bytes memory withdrawalCredentials_ = bytes.concat(withdrawalCredentials());

        for (uint256 i = 0; i < numberOfDeposits; i++) {
            StakingVaultDeposit calldata deposit = _deposits[i];

            DEPOSIT_CONTRACT.deposit{value: deposit.amount}(
                deposit.pubkey,
                withdrawalCredentials_,
                deposit.signature,
                deposit.depositDataRoot
            );
        }

        emit DepositedToBeaconChain(msg.sender, numberOfDeposits, totalAmount);
    }

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
            emit ValidatorExitRequested(msg.sender, /* indexed */ pubkey, pubkey);
        }
    }

    /**
     * @notice Triggers validator withdrawals from the beacon chain using EIP-7002 triggerable exit
     * @param _pubkeys Concatenated validators public keys, each 48 bytes long
     * @param _amounts Amounts of ether to exit, must match the length of _pubkeys
     * @param _refundRecipient Address to receive the fee refund, if zero, refunds go to msg.sender
     * @dev    The caller must provide sufficient fee via msg.value to cover the withdrawal request costs
     */
    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable onlyOwner {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_amounts.length == 0) revert ZeroArgument("_amounts");
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) revert InvalidPubkeysLength();

        // If the refund recipient is not set, use the sender as the refund recipient
        if (_refundRecipient == address(0)) {
            _refundRecipient = msg.sender;
        }

        uint256 feePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        uint256 totalFee = (_pubkeys.length / PUBLIC_KEY_LENGTH) * feePerRequest;
        if (msg.value < totalFee) revert InsufficientValidatorWithdrawalFee(msg.value, totalFee);

        TriggerableWithdrawals.addWithdrawalRequests(_pubkeys, _amounts, feePerRequest);

        uint256 excess = msg.value - totalFee;
        if (excess > 0) {
            (bool success, ) = _refundRecipient.call{value: excess}("");
            if (!success) revert WithdrawalFeeRefundFailed(_refundRecipient, excess);
        }

        emit ValidatorWithdrawalTriggered(msg.sender, _pubkeys, _amounts, _refundRecipient, excess);
    }

    function _storage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    event NodeOperatorSet(address indexed nodeOperator);

    /**
     * @notice Emitted when ether is received by `StakingVault`
     * @param sender Address that sent the ether
     * @param amount Amount of ether received
     */
    event EtherReceived(address indexed sender, uint256 amount);

    /**
     * @notice Emitted when ether is transferred from `StakingVault` to a recipient
     * @param sender Address that initiated the transfer
     * @param recipient Address that received the transfer
     * @param amount Amount of ether transferred
     */
    event EtherWithdrawn(address indexed sender, address indexed recipient, uint256 amount);

    event BeaconChainDepositsPaused();
    event BeaconChainDepositsResumed();

    event DepositedToBeaconChain(address indexed sender, uint256 numberOfDeposits, uint256 totalAmount);

    /**
     * @notice Emitted when vault owner requests node operator to exit validators from the beacon chain
     * @param _sender Address that requested the exit
     * @param _pubkey Indexed public key of the validator to exit
     * @param _pubkeyRaw Raw public key of the validator to exit
     * @dev    Signals to node operators that they should exit this validator from the beacon chain
     */
    event ValidatorExitRequested(address _sender, bytes indexed _pubkey, bytes _pubkeyRaw);

    /**
     * @notice Emitted when validator withdrawals are requested via EIP-7002
     * @param _sender Address that requested the withdrawals
     * @param _pubkeys Concatenated public keys of the validators to withdraw
     * @param _amounts Amounts of ether to withdraw per validator
     * @param _refundRecipient Address to receive any excess withdrawal fee
     * @param _excess Amount of excess fee refunded to recipient
     */
    event ValidatorWithdrawalTriggered(
        address indexed _sender,
        bytes _pubkeys,
        uint64[] _amounts,
        address _refundRecipient,
        uint256 _excess
    );

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when the transfer of ether to a recipient fails
     * @param recipient Address that was supposed to receive the transfer
     * @param amount Amount that failed to transfer
     */
    error TransferFailed(address recipient, uint256 amount);

    /**
     * @notice Thrown when the length of the validator public keys is invalid
     */
    error InvalidPubkeysLength();

    /**
     * @notice Thrown when the beacon chain deposits are paused
     */
    error BeaconChainDepositsPauseExpected();
    error BeaconChainDepositsResumeExpected();

    /**
     * @notice Thrown when the balance of the vault is insufficient
     * @param _balance Balance of the vault
     * @param _required Amount of ether required
     */
    error InsufficientBalance(uint256 _balance, uint256 _required);

    /**
     * @notice Thrown when the validator withdrawal fee is insufficient
     * @param _passed Amount of ether passed to the function
     * @param _required Amount of ether required to cover the fee
     */
    error InsufficientValidatorWithdrawalFee(uint256 _passed, uint256 _required);

    /**
     * @notice Thrown when a validator withdrawal fee refund fails
     * @param _sender Address that initiated the refund
     * @param _amount Amount of ether to refund
     */
    error WithdrawalFeeRefundFailed(address _sender, uint256 _amount);

    /**
     * @notice Thrown when the vault is already ossified
     */
    error AlreadyOssified();
}
