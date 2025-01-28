// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {TriggerableWithdrawals} from "contracts/common/lib/TriggerableWithdrawals.sol";

import {IDepositContract} from "../interfaces/IDepositContract.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

/// @notice VaultValidatorsManager is a contract that manages validators in the vault
/// @author tamtamchik
abstract contract VaultValidatorsManager {

    /**
     * @notice Address of `BeaconChainDepositContract`
     *         Set immutably in the constructor to avoid storage costs
     */
    IDepositContract private immutable BEACON_CHAIN_DEPOSIT_CONTRACT;

    constructor(address _beaconChainDepositContract) {
        if (_beaconChainDepositContract == address(0)) revert ZeroArgument("_beaconChainDepositContract");
        BEACON_CHAIN_DEPOSIT_CONTRACT = IDepositContract(_beaconChainDepositContract);
    }

    /// @notice Returns the address of `BeaconChainDepositContract`
    /// @return Address of `BeaconChainDepositContract`
    function _depositContract() internal view returns (address) {
        return address(BEACON_CHAIN_DEPOSIT_CONTRACT);
    }

    /// @notice Returns the 0x01-type withdrawal credentials for the validators deposited from this `StakingVault`
    ///         All CL rewards are sent to this contract. Only 0x01-type withdrawal credentials are supported for now.
    /// @return Withdrawal credentials as bytes32
    function _withdrawalCredentials() internal view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    /// @notice Deposits validators to the beacon chain deposit contract
    /// @param _deposits Array of validator deposits
    function _depositToBeaconChain(IStakingVault.Deposit[] calldata _deposits) internal {
        uint256 totalAmount = 0;
        uint256 numberOfDeposits = _deposits.length;
        for (uint256 i = 0; i < numberOfDeposits; i++) {
            IStakingVault.Deposit calldata deposit = _deposits[i];
            BEACON_CHAIN_DEPOSIT_CONTRACT.deposit{value: deposit.amount}(
                deposit.pubkey,
                bytes.concat(_withdrawalCredentials()),
                deposit.signature,
                deposit.depositDataRoot
            );
            totalAmount += deposit.amount;
        }

        emit DepositedToBeaconChain(msg.sender, numberOfDeposits, totalAmount);
    }

    /// @notice Requests validators to exit from the beacon chain
    /// @param _pubkeys Concatenated validator public keys
    function _requestValidatorsExit(bytes calldata _pubkeys) internal {
        _validateWithdrawalFee(_pubkeys);

        TriggerableWithdrawals.addFullWithdrawalRequests(_pubkeys, TriggerableWithdrawals.getWithdrawalRequestFee());
    }

    /// @notice Requests partial exit of validators from the beacon chain
    /// @param _pubkeys Concatenated validator public keys
    /// @param _amounts Array of withdrawal amounts for each validator
    function _requestValidatorsPartialExit(bytes calldata _pubkeys, uint64[] calldata _amounts) internal {
        _validateWithdrawalFee(_pubkeys);

        TriggerableWithdrawals.addPartialWithdrawalRequests(
            _pubkeys,
            _amounts,
            TriggerableWithdrawals.getWithdrawalRequestFee()
        );
    }

    /// @dev Validates that contract has enough balance to pay withdrawal fee
    /// @param _pubkeys Concatenated validator public keys
    function _validateWithdrawalFee(bytes calldata _pubkeys) private view {
        uint256 minFeePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        uint256 validatorCount = _pubkeys.length / TriggerableWithdrawals.PUBLIC_KEY_LENGTH;
        uint256 totalFee = validatorCount * minFeePerRequest;

        if (address(this).balance < totalFee) {
            revert InsufficientBalanceForWithdrawalFee(
                address(this).balance,
                totalFee,
                validatorCount
            );
        }
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
        bytes32 sigSlice1Root = sha256(abi.encodePacked(_signature[0:64]));
        bytes32 sigSlice2Root = sha256(abi.encodePacked(_signature[64:], bytes32(0)));
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
     * @notice Emitted when ether is deposited to `DepositContract`
     * @param sender Address that initiated the deposit
     * @param deposits Number of validator deposits made
     */
    event DepositedToBeaconChain(address indexed sender, uint256 deposits, uint256 totalAmount);

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when the balance is insufficient to cover the withdrawal request fee
     * @param balance Current balance of the contract
     * @param required Required balance to cover the fee
     * @param numberOfRequests Number of withdrawal requests
     */
    error InsufficientBalanceForWithdrawalFee(uint256 balance, uint256 required, uint256 numberOfRequests);
}
