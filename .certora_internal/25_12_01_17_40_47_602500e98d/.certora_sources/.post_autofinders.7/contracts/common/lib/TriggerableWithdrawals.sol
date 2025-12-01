// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

/**
 * @title A lib for EIP-7002: Execution layer triggerable withdrawals.
 * Allow validators to trigger withdrawals and exits from their execution layer (0x01) withdrawal credentials.
 */
library TriggerableWithdrawals {
    address constant WITHDRAWAL_REQUEST = 0x00000961Ef480Eb55e80D19ad83579A64c007002;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    uint256 internal constant WITHDRAWAL_AMOUNT_LENGTH = 8;
    uint256 internal constant WITHDRAWAL_REQUEST_CALLDATA_LENGTH = 56;

    error WithdrawalFeeReadFailed();
    error WithdrawalFeeInvalidData();
    error WithdrawalRequestAdditionFailed(bytes callData);

    error NoWithdrawalRequests();
    error MalformedPubkeysArray();
    error PartialWithdrawalRequired(uint256 index);
    error MismatchedArrayLengths(uint256 keysCount, uint256 amountsCount);

    /**
     * @dev Send EIP-7002 full withdrawal requests for the specified public keys.
     *      Each request instructs a validator to fully withdraw its stake and exit its duties as a validator.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting full withdrawals.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param feePerRequest The withdrawal fee for each withdrawal request.
     *        - Must be greater than or equal to the current minimal withdrawal fee.
     *
     * @notice Reverts if:
     *         - Validation of the public keys fails.
     *         - The provided fee per request is insufficient.
     *         - The contract has an insufficient balance to cover the total fees.
     */
    function addFullWithdrawalRequests(bytes calldata pubkeys, uint256 feePerRequest) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02210000, 1037618709025) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02210001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02213000, pubkeys.offset) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02212000, pubkeys.length) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02211001, feePerRequest) }
        uint256 keysCount = _validateAndCountPubkeys(pubkeys);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000014,keysCount)}

        bytes memory callData = new bytes(56);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010015,0)}

        for (uint256 i = 0; i < keysCount; i++) {
            _copyAmountWithPubkeyToMemory(callData, 0, pubkeys, i);

            (bool success, ) = WITHDRAWAL_REQUEST.call{value: feePerRequest}(callData);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001a,0)}

            if (!success) {
                revert WithdrawalRequestAdditionFailed(callData);
            }
        }
    }

    /**
     * @dev Send EIP-7002 partial withdrawal requests for the specified public keys with corresponding amounts.
     *      Each request instructs a validator to partially withdraw its stake.
     *      A partial withdrawal is any withdrawal where the amount is greater than zero,
     *      allows withdrawal of any balance exceeding 32 ETH (e.g., if a validator has 35 ETH, up to 3 ETH can be withdrawn),
     *      the protocol enforces a minimum balance of 32 ETH per validator, even if a higher amount is requested.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting full withdrawals.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param amounts An array of corresponding partial withdrawal amounts for each public key.
     *
     * @param feePerRequest The withdrawal fee for each withdrawal request.
     *        - Must be greater than or equal to the current minimal withdrawal fee.
     *
     * @notice Reverts if:
     *         - Validation of the public keys fails.
     *         - The pubkeys and amounts length mismatch.
     *         - Full withdrawal requested for any pubkeys (withdrawal amount = 0).
     *         - The provided fee per request is insufficient.
     *         - The contract has an insufficient balance to cover the total fees.
     */
    function addPartialWithdrawalRequests(
        bytes calldata pubkeys,
        uint64[] calldata amounts,
        uint256 feePerRequest
    ) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02220000, 1037618709026) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02220001, 5) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02223000, pubkeys.offset) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02222000, pubkeys.length) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02223001, amounts.offset) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02222001, amounts.length) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02221002, feePerRequest) }
        for (uint256 i = 0; i < amounts.length; i++) {
            if (amounts[i] == 0) {
                revert PartialWithdrawalRequired(i);
            }
        }

        addWithdrawalRequests(pubkeys, amounts, feePerRequest);
    }

    /**
     * @dev Send EIP-7002 partial or full withdrawal requests for the specified public keys with corresponding amounts.
     *      Each request instructs a validator to partially or fully withdraw its stake.

     *      1. A partial withdrawal is any withdrawal where the amount is greater than zero,
     *      allows withdrawal of any balance exceeding 32 ETH (e.g., if a validator has 35 ETH, up to 3 ETH can be withdrawn),
     *      the protocol enforces a minimum balance of 32 ETH per validator, even if a higher amount is requested.
     *
     *      2. A full withdrawal is a withdrawal where the amount is equal to zero,
     *      allows to fully withdraw validator stake and exit its duties as a validator.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting full withdrawals.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param amounts An array of corresponding partial withdrawal amounts for each public key.
     *
     * @param feePerRequest The withdrawal fee for each withdrawal request.
     *        - Must be greater than or equal to the current minimal withdrawal fee.
     *
     * @notice Reverts if:
     *         - Validation of the public keys fails.
     *         - The pubkeys and amounts length mismatch.
     *         - The provided fee per request is insufficient.
     *         - The contract has an insufficient balance to cover the total fees.
     */
    function addWithdrawalRequests(bytes calldata pubkeys, uint64[] calldata amounts, uint256 feePerRequest) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02240000, 1037618709028) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02240001, 5) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02243000, pubkeys.offset) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02242000, pubkeys.length) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02243001, amounts.offset) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02242001, amounts.length) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02241002, feePerRequest) }
        uint256 keysCount = _validateAndCountPubkeys(pubkeys);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000016,keysCount)}

        if (keysCount != amounts.length) {
            revert MismatchedArrayLengths(keysCount, amounts.length);
        }

        bytes memory callData = new bytes(56);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010017,0)}
        for (uint256 i = 0; i < keysCount; i++) {
            _copyAmountWithPubkeyToMemory(callData, amounts[i], pubkeys, i);

            (bool success, ) = WITHDRAWAL_REQUEST.call{value: feePerRequest}(callData);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001b,0)}

            if (!success) {
                revert WithdrawalRequestAdditionFailed(callData);
            }
        }
    }

    /**
     * @dev Retrieves the current EIP-7002 withdrawal fee.
     * @return The minimum fee required per withdrawal request.
     */
    function getWithdrawalRequestFee() internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02250000, 1037618709029) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02250001, 0) }
        (bool success, bytes memory feeData) = WITHDRAWAL_REQUEST.staticcall("");assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010018,0)}

        if (!success) {
            revert WithdrawalFeeReadFailed();
        }

        if (feeData.length != 32) {
            revert WithdrawalFeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function _copyAmountWithPubkeyToMemory(
        bytes memory target,
        uint64 amount,
        bytes calldata pubkeys,
        uint256 keyIndex
    ) private pure {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02230000, 1037618709027) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02230001, 5) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02231000, target) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02231001, amount) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02233002, pubkeys.offset) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02232002, pubkeys.length) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02231003, keyIndex) }
        assembly {
            // Write the amount first:
            // mstore at [56..88) → uint64 lands in [80..88), zeroes [56..80)
            mstore(add(target, 56), amount)

            // Then write the 48-byte pubkey into [32..80), overwriting the zeros above.
            calldatacopy(
                add(target, 32),
                add(pubkeys.offset, mul(keyIndex, PUBLIC_KEY_LENGTH)),
                PUBLIC_KEY_LENGTH
            )
        }
    }

    function _validateAndCountPubkeys(bytes calldata pubkeys) private pure returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02260000, 1037618709030) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02260001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02263000, pubkeys.offset) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02262000, pubkeys.length) }
        if (pubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert MalformedPubkeysArray();
        }

        uint256 keysCount = pubkeys.length / PUBLIC_KEY_LENGTH;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000019,keysCount)}
        if (keysCount == 0) {
            revert NoWithdrawalRequests();
        }

        return keysCount;
    }
}
