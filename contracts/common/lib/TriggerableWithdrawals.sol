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
    function addFullWithdrawalRequests(bytes calldata pubkeys, uint256 feePerRequest) internal {
        uint256 keysCount = _validateAndCountPubkeys(pubkeys);

        bytes memory callData = new bytes(56);

        for (uint256 i = 0; i < keysCount; i++) {
            _copyPubkeyToMemory(pubkeys, callData, i);

            (bool success, ) = WITHDRAWAL_REQUEST.call{value: feePerRequest}(callData);

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
    ) internal {
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
    function addWithdrawalRequests(bytes calldata pubkeys, uint64[] calldata amounts, uint256 feePerRequest) internal {
        uint256 keysCount = _validateAndCountPubkeys(pubkeys);

        if (keysCount != amounts.length) {
            revert MismatchedArrayLengths(keysCount, amounts.length);
        }

        bytes memory callData = new bytes(56);
        for (uint256 i = 0; i < keysCount; i++) {
            _copyPubkeyToMemory(pubkeys, callData, i);
            _copyAmountToMemory(callData, amounts[i]);

            (bool success, ) = WITHDRAWAL_REQUEST.call{value: feePerRequest}(callData);

            if (!success) {
                revert WithdrawalRequestAdditionFailed(callData);
            }
        }
    }

    /**
     * @dev Retrieves the current EIP-7002 withdrawal fee.
     * @return The minimum fee required per withdrawal request.
     */
    function getWithdrawalRequestFee() internal view returns (uint256) {
        (bool success, bytes memory feeData) = WITHDRAWAL_REQUEST.staticcall("");

        if (!success) {
            revert WithdrawalFeeReadFailed();
        }

        if (feeData.length != 32) {
            revert WithdrawalFeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function _copyPubkeyToMemory(bytes calldata pubkeys, bytes memory target, uint256 keyIndex) private pure {
        assembly {
            calldatacopy(add(target, 32), add(pubkeys.offset, mul(keyIndex, PUBLIC_KEY_LENGTH)), PUBLIC_KEY_LENGTH)
        }
    }

    function _copyAmountToMemory(bytes memory target, uint64 amount) private pure {
        assembly {
            mstore(add(target, 80), shl(192, amount))
        }
    }

    function _validateAndCountPubkeys(bytes calldata pubkeys) private pure returns (uint256) {
        if (pubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert MalformedPubkeysArray();
        }

        uint256 keysCount = pubkeys.length / PUBLIC_KEY_LENGTH;
        if (keysCount == 0) {
            revert NoWithdrawalRequests();
        }

        return keysCount;
    }
}
