// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {TriggerableWithdrawals} from "contracts/common/lib/TriggerableWithdrawals.sol";

import {IDepositContract} from "../interfaces/IDepositContract.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

/// @notice Abstract contract that manages validator deposits and exits for staking vaults
abstract contract ValidatorsManager {

    /// @notice The Beacon Chain deposit contract used for staking validators
    IDepositContract private immutable BEACON_CHAIN_DEPOSIT_CONTRACT;

    /// @notice Constructor that sets the Beacon Chain deposit contract
    /// @param _beaconChainDepositContract Address of the Beacon Chain deposit contract
    constructor(address _beaconChainDepositContract) {
        if (_beaconChainDepositContract == address(0)) revert ZeroBeaconChainDepositContract();

        BEACON_CHAIN_DEPOSIT_CONTRACT = IDepositContract(_beaconChainDepositContract);
    }

    /// @notice Returns the address of the Beacon Chain deposit contract
    /// @return Address of the Beacon Chain deposit contract
    function _getDepositContract() internal view returns (address) {
        return address(BEACON_CHAIN_DEPOSIT_CONTRACT);
    }

    /// @notice Returns the 0x01-type withdrawal credentials for the validators deposited from this contract
    /// @dev    All consensus layer rewards are sent to this contract. Only 0x01-type withdrawal credentials are supported.
    /// @return bytes32 The withdrawal credentials, with 0x01 prefix followed by this contract's address
    function _getWithdrawalCredentials() internal view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    /// @notice Deposits validators to the beacon chain deposit contract
    /// @param _deposits Array of validator deposits containing pubkey, signature, amount and deposit data root
    function _depositToBeaconChain(IStakingVault.Deposit[] calldata _deposits) internal {
        uint256 totalAmount = 0;
        uint256 numberOfDeposits = _deposits.length;
        for (uint256 i = 0; i < numberOfDeposits; i++) {
            IStakingVault.Deposit calldata deposit = _deposits[i];
            BEACON_CHAIN_DEPOSIT_CONTRACT.deposit{value: deposit.amount}(
                deposit.pubkey,
                bytes.concat(_getWithdrawalCredentials()),
                deposit.signature,
                deposit.depositDataRoot
            );
            totalAmount += deposit.amount;
        }

        emit DepositedToBeaconChain(msg.sender, numberOfDeposits, totalAmount);
    }

    /// @notice Calculates the total exit request fee for a given number of validator keys
    /// @param _numberOfKeys Number of validator keys
    /// @return Total fee amount
    function _calculateTotalExitRequestFee(uint256 _numberOfKeys) internal view returns (uint256) {
        return _numberOfKeys * TriggerableWithdrawals.getWithdrawalRequestFee();
    }

    /// @notice Emits the ValidatorsExitRequest event
    /// @param _pubkeys Concatenated validator public keys, each 48 bytes long
    function _requestValidatorsExit(bytes calldata _pubkeys) internal {
        emit ValidatorsExitRequested(msg.sender, _pubkeys);
    }

    /// @notice Requests full exit of validators from the beacon chain by submitting their public keys
    /// @param _pubkeys Concatenated validator public keys, each 48 bytes long
    /// @dev    The caller must provide sufficient fee via msg.value to cover the exit request costs
    function _forceValidatorsExit(bytes calldata _pubkeys) internal {
        (uint256 feePerRequest, uint256 totalFee) = _getAndValidateExitFees(_pubkeys);

        TriggerableWithdrawals.addFullWithdrawalRequests(_pubkeys, feePerRequest);

        emit ValidatorsExitForced(msg.sender, _pubkeys);

        _refundExcessExitFee(totalFee);
    }

    /// @notice Requests partial exit of validators from the beacon chain by submitting their public keys and exit amounts
    /// @param _pubkeys Concatenated validator public keys, each 48 bytes long
    /// @param _amounts Array of exit amounts in Gwei for each validator, must match number of validators in _pubkeys
    /// @dev    The caller must provide sufficient fee via msg.value to cover the exit request costs
    function _forcePartialValidatorsExit(bytes calldata _pubkeys, uint64[] calldata _amounts) internal {
        (uint256 feePerRequest, uint256 totalFee) = _getAndValidateExitFees(_pubkeys);

        TriggerableWithdrawals.addPartialWithdrawalRequests(_pubkeys, _amounts, feePerRequest);

        emit PartialValidatorsExitForced(msg.sender, _pubkeys, _amounts);

        _refundExcessExitFee(totalFee);
    }

    /// @notice Refunds excess fee back to the sender if they sent more than required
    /// @param _totalFee Total fee required for the exit request that will be kept
    /// @dev    Sends back any msg.value in excess of _totalFee to msg.sender
    function _refundExcessExitFee(uint256 _totalFee) private {
        uint256 excess = msg.value - _totalFee;

        if (excess > 0) {
            (bool success,) = msg.sender.call{value: excess}("");
            if (!success) {
                revert ExitFeeRefundFailed(msg.sender, excess);
            }

            emit ExitFeeRefunded(msg.sender, excess);
        }
    }

    /// @notice Validates that sufficient fee was provided to cover validator exit requests
    /// @param _pubkeys Concatenated validator public keys, each 48 bytes long
    /// @return feePerRequest Fee per request for the exit request
    function _getAndValidateExitFees(bytes calldata _pubkeys) private view returns (uint256 feePerRequest, uint256 totalFee) {
        feePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        totalFee = _pubkeys.length / TriggerableWithdrawals.PUBLIC_KEY_LENGTH * feePerRequest;

        if (msg.value < totalFee) {
            revert InsufficientExitFee(msg.value, totalFee);
        }

        return (feePerRequest, totalFee);
    }

    /// @notice Computes the deposit data root for a validator deposit
    /// @param _pubkey Validator public key, 48 bytes
    /// @param _withdrawalCredentials Withdrawal credentials, 32 bytes
    /// @param _signature Signature of the deposit, 96 bytes
    /// @param _amount Amount of ether to deposit, in wei
    /// @return Deposit data root as bytes32
    /// @dev This function computes the deposit data root according to the deposit contract's specification.
    ///      The deposit data root is check upon deposit to the deposit contract as a protection against malformed deposit data.
    ///      See more: https://etherscan.io/address/0x00000000219ab540356cbb839cbe05303d7705fa#code
    function _computeDepositDataRoot(
        bytes calldata _pubkey,
        bytes calldata _withdrawalCredentials,
        bytes calldata _signature,
        uint256 _amount
    ) internal pure returns (bytes32) {
        // Step 1. Convert the deposit amount in wei to gwei in 64-bit bytes
        bytes memory amountBE64 = abi.encodePacked(uint64(_amount / 1 gwei));

        // Step 2. Convert the amount to little-endian format by flipping the bytes 🧠
        bytes memory amountLE64 = new bytes(8);
        amountLE64[0] = amountBE64[7];
        amountLE64[1] = amountBE64[6];
        amountLE64[2] = amountBE64[5];
        amountLE64[3] = amountBE64[4];
        amountLE64[4] = amountBE64[3];
        amountLE64[5] = amountBE64[2];
        amountLE64[6] = amountBE64[1];
        amountLE64[7] = amountBE64[0];

        // Step 3. Compute the root of the pubkey
        bytes32 pubkeyRoot = sha256(abi.encodePacked(_pubkey, bytes16(0)));

        // Step 4. Compute the root of the signature
        bytes32 sigSlice1Root = sha256(abi.encodePacked(_signature[0 : 64]));
        bytes32 sigSlice2Root = sha256(abi.encodePacked(_signature[64 :], bytes32(0)));
        bytes32 signatureRoot = sha256(abi.encodePacked(sigSlice1Root, sigSlice2Root));

        // Step 5. Compute the root-toot-toorootoo of the deposit data
        bytes32 depositDataRoot = sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(pubkeyRoot, _withdrawalCredentials)),
                sha256(abi.encodePacked(amountLE64, bytes24(0), signatureRoot))
            )
        );

        return depositDataRoot;
    }

    /**
     * @notice Thrown when `BeaconChainDepositContract` is not set
     */
    error ZeroBeaconChainDepositContract();

    /**
     * @notice Emitted when ether is deposited to `DepositContract`
     * @param _sender Address that initiated the deposit
     * @param _deposits Number of validator deposits made
     * @param _totalAmount Total amount of ether deposited
     */
    event DepositedToBeaconChain(address indexed _sender, uint256 _deposits, uint256 _totalAmount);

    /**
     * @notice Emitted when a validator exit request is made
     * @dev Signals `nodeOperator` to exit the validator
     * @param _sender Address that requested the validator exit
     * @param _pubkeys Public key of the validator requested to exit
     */
    event ValidatorsExitRequested(address indexed _sender, bytes _pubkeys);

    /**
     * @notice Emitted when a validator exit request is forced via EIP-7002
     * @dev Signals `nodeOperator` to exit the validator
     * @param _sender Address that requested the validator exit
     * @param _pubkeys Public key of the validator requested to exit
     */
    event ValidatorsExitForced(address indexed _sender, bytes _pubkeys);

    /**
     * @notice Emitted when a validator partial exit request is forced via EIP-7002
     * @dev Signals `nodeOperator` to exit the validator
     * @param _sender Address that requested the validator partial exit
     * @param _pubkeys Public key of the validator requested to exit
     * @param _amounts Amounts of ether requested to exit
     */
    event PartialValidatorsExitForced(address indexed _sender, bytes _pubkeys, uint64[] _amounts);

    /**
     * @notice Emitted when an excess fee is refunded back to the sender
     * @param _sender Address that received the refund
     * @param _amount Amount of ether refunded
     */
    event ExitFeeRefunded(address indexed _sender, uint256 _amount);

    /**
     * @notice Thrown when the balance is insufficient to cover the exit request fee
     * @param _passed Amount of ether passed to the function
     * @param _required Amount of ether required to cover the fee
     */
    error InsufficientExitFee(uint256 _passed, uint256 _required);

    /**
     * @notice Thrown when a transfer fails
     * @param _sender Address that initiated the transfer
     * @param _amount Amount of ether to transfer
     */
    error ExitFeeRefundFailed(address _sender, uint256 _amount);
}
