// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import { Memory } from "../lib/Memory.sol";
import { IDepositContract } from "../interfaces/IDepositContract.sol";

/**
 * @title DepositLogistics
 * @notice Library for handling Beacon Chain validator deposits
 * @dev Provides functionality to process multiple validator deposits to the Beacon Chain deposit contract
 */
library DepositLogistics {
    uint256 internal constant SIGNATURE_LENGTH = 96;
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    uint256 internal constant SIZE_LENGTH = 8;

    error ZeroKeyCount();
    error PubkeysLengthMismatch(uint256 actual, uint256 expected);
    error SignaturesLengthMismatch(uint256 actual, uint256 expected);
    error SizesLengthMismatch(uint256 actual, uint256 expected);

    /**
     * @notice Processes multiple validator deposits to the Beacon Chain deposit contract
     * @param _depositContract The deposit contract interface
     * @param _keyCount Number of validator keys to process
     * @param _creds Withdrawal credentials for the validators
     * @param _pubkeys Concatenated validator public keys
     * @param _sigs Concatenated validator signatures
     * @param _sizes Array of deposit sizes in gwei
     * @dev Each validator requires a 48-byte public key, 96-byte signature, and 8-byte deposit size
     */
    function processDeposits(
        IDepositContract _depositContract,
        uint256 _keyCount,
        bytes memory _creds,
        bytes memory _pubkeys,
        bytes memory _sigs,
        bytes memory _sizes
    ) internal {
        if (_keyCount == 0) revert ZeroKeyCount();
        if (_pubkeys.length != PUBLIC_KEY_LENGTH * _keyCount) revert PubkeysLengthMismatch(_pubkeys.length, PUBLIC_KEY_LENGTH * _keyCount);
        if (_sigs.length != SIGNATURE_LENGTH * _keyCount) revert SignaturesLengthMismatch(_sigs.length, SIGNATURE_LENGTH * _keyCount);
        if (_sizes.length != SIZE_LENGTH * _keyCount) revert SizesLengthMismatch(_sizes.length, SIZE_LENGTH * _keyCount);

        bytes memory pubkey = Memory.alloc(PUBLIC_KEY_LENGTH);
        bytes memory signature = Memory.alloc(SIGNATURE_LENGTH);
        bytes memory size = Memory.alloc(SIZE_LENGTH);

        for (uint256 i; i < _keyCount; i++) {
            Memory.copy(_pubkeys, pubkey, i * PUBLIC_KEY_LENGTH, 0, PUBLIC_KEY_LENGTH);
            Memory.copy(_sigs, signature, i * SIGNATURE_LENGTH, 0, SIGNATURE_LENGTH);
            Memory.copy(_sizes, size, i * SIZE_LENGTH, 0, SIZE_LENGTH);

            uint256 sizeInWei = uint256(uint64(bytes8(size))) * 1 gwei;
            bytes32 root = _computeRoot(_creds, pubkey, signature, size);

            _depositContract.deposit{value: sizeInWei}(pubkey, _creds, signature, root);
        }
    }

    /**
     * @notice Computes the deposit data root hash
     * @param _creds Withdrawal credentials
     * @param _pubkey BLS12-381 public key
     * @param _signature BLS12-381 signature
     * @param _size Deposit size in gwei
     * @return bytes32 The computed deposit data root hash
     * @dev Implements the deposit data root calculation as specified in the Beacon Chain deposit contract
     */
    function _computeRoot(
        bytes memory _creds,
        bytes memory _pubkey,
        bytes memory _signature,
        bytes memory _size
    ) internal pure returns (bytes32) {
        bytes32 pubkeyRoot = keccak256(abi.encodePacked(_pubkey, bytes16(0)));

        bytes32 sigRoot = keccak256(
            abi.encodePacked(
                keccak256(abi.encodePacked(Memory.slice(_signature, 0, 64))),
                keccak256(abi.encodePacked(Memory.slice(_signature, 64, SIGNATURE_LENGTH - 64), bytes32(0)))
            )
        );

        bytes memory sizeInGweiLE64 = _toLittleEndian(_size);

        return
            keccak256(
                abi.encodePacked(
                    keccak256(abi.encodePacked(pubkeyRoot, _creds)),
                    keccak256(abi.encodePacked(sizeInGweiLE64, bytes24(0), sigRoot))
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
}

