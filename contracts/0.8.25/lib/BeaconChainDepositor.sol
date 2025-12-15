// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {MemUtils} from "contracts/common/lib/MemUtils.sol";

interface IDepositContract {
    function get_deposit_root() external view returns (bytes32 rootHash);

    function deposit(
        bytes calldata pubkey, // 48 bytes
        bytes calldata withdrawal_credentials, // 32 bytes
        bytes calldata signature, // 96 bytes
        bytes32 deposit_data_root
    ) external payable;
}

library BeaconChainDepositor {
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    uint256 internal constant SIGNATURE_LENGTH = 96;

    uint256 internal constant DEPOSIT_SIZE = 32 ether;
    uint64 internal constant DEPOSIT_SIZE_IN_GWEI = 32 ether / 1 gwei;

    /// @dev Invokes a deposit call to the official Beacon Deposit contract
    /// @param _depositContract - IDepositContract deposit contract
    /// @param _keysCount amount of keys to deposit
    /// @param _withdrawalCredentials Commitment to a public key for withdrawals
    /// @param _publicKeysBatch A BLS12-381 public keys batch
    /// @param _signaturesBatch A BLS12-381 signatures batch
    function makeBeaconChainDeposits32ETH(
        IDepositContract _depositContract,
        uint256 _keysCount,
        bytes memory _withdrawalCredentials,
        bytes memory _publicKeysBatch,
        bytes memory _signaturesBatch
    ) public {
        if (_publicKeysBatch.length != PUBLIC_KEY_LENGTH * _keysCount) {
            revert InvalidPublicKeysBatchLength(_publicKeysBatch.length, PUBLIC_KEY_LENGTH * _keysCount);
        }
        if (_signaturesBatch.length != SIGNATURE_LENGTH * _keysCount) {
            revert InvalidSignaturesBatchLength(_signaturesBatch.length, SIGNATURE_LENGTH * _keysCount);
        }

        bytes memory publicKey = MemUtils.unsafeAllocateBytes(PUBLIC_KEY_LENGTH);
        bytes memory signature = MemUtils.unsafeAllocateBytes(SIGNATURE_LENGTH);

        for (uint256 i; i < _keysCount; ++i) {
            MemUtils.copyBytes(_publicKeysBatch, publicKey, i * PUBLIC_KEY_LENGTH, 0, PUBLIC_KEY_LENGTH);
            MemUtils.copyBytes(_signaturesBatch, signature, i * SIGNATURE_LENGTH, 0, SIGNATURE_LENGTH);

            _depositContract.deposit{value:  DEPOSIT_SIZE}(
                publicKey,
                _withdrawalCredentials,
                signature,
                _computeDepositDataRootWithAmount(_withdrawalCredentials, publicKey, signature, DEPOSIT_SIZE_IN_GWEI)
            );
        }
    }

    function makeBeaconChainTopUp(
        IDepositContract _depositContract,
        bytes memory _withdrawalCredentials,
        bytes[] memory _publicKeys,
        uint256[] memory _amountGwei
    ) external {
        uint256 len = _publicKeys.length;
        if (len == 0) return;
        if (len != _amountGwei.length) revert ArrayLengthMismatch();

        bytes memory dummySignature = new bytes(SIGNATURE_LENGTH);

        for (uint256 i; i < len; ++i) {
            bytes memory pk = _publicKeys[i];

            if (pk.length != PUBLIC_KEY_LENGTH) {
                revert InvalidPublicKeysBatchLength(pk.length, PUBLIC_KEY_LENGTH);
            }

            uint256 amountGwei256 = _amountGwei[i];
            if (amountGwei256 > type(uint64).max) {
                revert AmountTooLarge();
            }

            // obtainDepositData can return 0 amount for some keys
            if (amountGwei256 == 0) continue;

            uint64 amountGwei64 = uint64(amountGwei256);
            uint256 amountWei = uint256(amountGwei64) * 1 gwei;

            // full DepositData root with custom amount
            bytes32 depositDataRoot =  _computeDepositDataRootWithAmount(
                _withdrawalCredentials,
                pk,
                dummySignature,
                amountGwei64
            );

            _depositContract.deposit{value: amountWei}(
                pk,
                _withdrawalCredentials,
                dummySignature,
                depositDataRoot
            );
        }

    }

    function _computeDepositDataRootWithAmount(
        bytes memory _withdrawalCredentials,
        bytes memory _publicKey,
        bytes memory _signature,
        uint64 _amountGwei
    ) private pure returns (bytes32) {
        bytes32 publicKeyRoot = sha256(abi.encodePacked(_publicKey, bytes16(0)));
        bytes32 signatureRoot = _computeSignatureRoot(_signature);
        bytes8 amountLE = _toLittleEndian64(_amountGwei);

        return sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(publicKeyRoot, _withdrawalCredentials)),
                sha256(abi.encodePacked(amountLE, bytes24(0), signatureRoot))
            )
        );
    }

    function _computeSignatureRoot(
        bytes memory _signature
    ) private pure returns (bytes32) {
        bytes memory sigPart1 = MemUtils.unsafeAllocateBytes(64);
        bytes memory sigPart2 = MemUtils.unsafeAllocateBytes(SIGNATURE_LENGTH - 64);

        MemUtils.copyBytes(_signature, sigPart1, 0, 0, 64);
        MemUtils.copyBytes(_signature, sigPart2, 64, 0, SIGNATURE_LENGTH - 64);

        return sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(sigPart1)),
                sha256(abi.encodePacked(sigPart2, bytes32(0)))
            )
        );
    }

    function _toLittleEndian64(uint64 value) private pure returns (bytes8 ret) { 
        ret = bytes8(0);
        for (uint256 i = 0; i < 8; ++i) {
            ret |= bytes8(bytes1(uint8(value >> (8 * i)))) >> (8 * i); 
        }
    }

    // error DepositContractZeroAddress();
    error InvalidPublicKeysBatchLength(uint256 actual, uint256 expected);
    error InvalidSignaturesBatchLength(uint256 actual, uint256 expected);
    error ArrayLengthMismatch();
    error AmountTooLarge();
}