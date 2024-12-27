// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import { Memory } from "../lib/Memory.sol";
import { IDepositContract } from "../interfaces/IDepositContract.sol";
import {ECDSA} from "contracts/common/lib/ECDSA.sol";

/**
 * @title DepositLogistics
 * @notice Library for handling Beacon Chain validator deposits
 * @dev Provides functionality to process multiple validator deposits to the Beacon Chain deposit contract
 */
library DepositLogistics {
    struct Signature {
        bytes32 r;
        bytes32 vs;
    }

    /**
     * @notice Byte length of the BLS12-381 public key (a.k.a. validator public key)
     */
    uint256 internal constant PUBKEY_LENGTH = 48;

    /**
     * @notice Byte length of the BLS12-381 signature of the deposit message
     */
    uint256 internal constant SIG_LENGTH = 96;

    /**
     * @notice Byte length of the deposit amount (value) in gwei
     */
    uint256 internal constant AMOUNT_LENGTH = 8;

    /**
     * @notice Domain separator for the security signature
     */
    bytes32 internal constant GUARDIAN_SIGNATURE_PREFIX = keccak256(abi.encodePacked("  "));

    /**
     * @notice Error thrown when the number of deposits is zero
     */
    error ZeroDeposits();

    /**
     * @notice Error thrown when the length of the pubkeys array does not match the expected length
     */
    error PubkeysLengthMismatch(uint256 actual, uint256 expected);

    /**
     * @notice Error thrown when the length of the signatures array does not match the expected length
     */
    error SigsLengthMismatch(uint256 actual, uint256 expected);

    /**
     * @notice Error thrown when the length of the concatenated amounts does not match the expected length
     */
    error AmountsLengthMismatch(uint256 actual, uint256 expected);

    /**
     * @notice Error thrown when the guardian signature does not match the expected guardian
     */
    error InvalidGuardianSignature();

    /**
     * @notice Processes multiple validator deposits to the Beacon Chain deposit contract
     * @param _depositContract The deposit contract interface
     * @param _deposits Number of validator keys to process
     * @param _creds Withdrawal credentials for the validators
     * @param _pubkeys Concatenated validator public keys
     * @param _sigs Concatenated validator signatures
     * @param _amounts Concatenated deposit amounts in gwei in byte format
     */
    function processDeposits(
        IDepositContract _depositContract,
        uint256 _deposits,
        bytes memory _creds,
        bytes memory _pubkeys,
        bytes memory _sigs,
        bytes memory _amounts,
        Signature memory _guardianSignature,
        address _guardian
    ) internal {
        if (_deposits == 0) revert ZeroDeposits();
        if (_pubkeys.length != PUBKEY_LENGTH * _deposits) revert PubkeysLengthMismatch(_pubkeys.length, PUBKEY_LENGTH * _deposits);
        if (_sigs.length != SIG_LENGTH * _deposits) revert SigsLengthMismatch(_sigs.length, SIG_LENGTH * _deposits);
        if (_amounts.length != AMOUNT_LENGTH * _deposits) revert AmountsLengthMismatch(_amounts.length, AMOUNT_LENGTH * _deposits);

        // Allocate memory for pubkey, sig, and amount to be reused for each deposit
        bytes memory pubkey = Memory.alloc(PUBKEY_LENGTH);
        bytes memory sig = Memory.alloc(SIG_LENGTH);
        bytes memory amount = Memory.alloc(AMOUNT_LENGTH);

        // aggregate deposit data roots
        bytes memory depositDataRoots;

        for (uint256 i; i < _deposits; i++) {
            // Copy pubkey, sig, and amount to the allocated memory slots
            Memory.copy(_pubkeys, pubkey, i * PUBKEY_LENGTH, 0, PUBKEY_LENGTH);
            Memory.copy(_sigs, sig, i * SIG_LENGTH, 0, SIG_LENGTH);
            Memory.copy(_amounts, amount, i * AMOUNT_LENGTH, 0, AMOUNT_LENGTH);

            uint256 amountInWei = _gweiBytesToWei(amount);
            bytes32 root = _computeRoot(_creds, pubkey, sig, amount);

            depositDataRoots = abi.encodePacked(depositDataRoots, root);

            _depositContract.deposit{value: amountInWei}(pubkey, _creds, sig, root);
        }

        // reverts the deposit transaction if the current deposit root does not match the expected one.
        // The expected deposit root is the one against which the guardian signature was produced, i.e.
        // against which the deposit data was validated to make sure there were no deposits with these pubkeys,
        // i.e. no deposit front-running.

        // the guardians signs a concatenation of 3 things:
        // 1. deposit prefix (a constant that reduces the signature validity space)
        // 2. the deposit root against which the deposit data was validated
        // 3. the aggregate of all deposit data roots

        bytes32 currentDepositRoot = _depositContract.get_deposit_root();
        bytes32 securityMessageHash = keccak256(abi.encodePacked(GUARDIAN_SIGNATURE_PREFIX, currentDepositRoot, depositDataRoots));
        address signer = ECDSA.recover(securityMessageHash, _guardianSignature.r, _guardianSignature.vs);

        if (signer != _guardian) revert InvalidGuardianSignature();
    }

    /**
     * @notice Computes the deposit data root hash
     * @param _creds Withdrawal credentials
     * @param _pubkey BLS12-381 public key
     * @param _sig BLS12-381 signature
     * @param _amount Deposit amount in gwei
     * @return bytes32 The computed deposit data root hash
     * @dev Implements the deposit data root calculation as specified in the Beacon Chain deposit contract
     */
    function _computeRoot(
        bytes memory _creds,
        bytes memory _pubkey,
        bytes memory _sig,
        bytes memory _amount
    ) internal pure returns (bytes32) {
        bytes32 pubkeyRoot = keccak256(abi.encodePacked(_pubkey, bytes16(0)));

        bytes32 sigRoot = keccak256(
            abi.encodePacked(
                keccak256(abi.encodePacked(Memory.slice(_sig, 0, 64))),
                keccak256(abi.encodePacked(Memory.slice(_sig, 64, SIG_LENGTH - 64), bytes32(0)))
            )
        );

        bytes memory amountInGweiLE64 = _toLittleEndian(_amount);

        return
            keccak256(
                abi.encodePacked(
                    keccak256(abi.encodePacked(pubkeyRoot, _creds)),
                    keccak256(abi.encodePacked(amountInGweiLE64, bytes24(0), sigRoot))
                )
            );
    }

    /**
     * @notice Converts a byte array to little-endian format
     * @param _value The byte array to convert
     * @return result The converted byte array in little-endian format
     * @dev Simply reverses the byte array
     */
    function _toLittleEndian(bytes memory _value) internal pure returns (bytes memory result) {
        result = new bytes(_value.length);

        for (uint256 i = 0; i < _value.length; i++) {
            result[i] = _value[_value.length - i - 1];
        }
    }

    /**
     * @notice Converts a gwei value in bytes to a uint256 wei value
     * @param _value The gwei value in bytes
     * @return result The converted uint256 wei value
     */
    function _gweiBytesToWei(bytes memory _value) internal pure returns (uint256) {
        return uint256(uint64(bytes8(_value))) * 1 gwei;
    }
}

