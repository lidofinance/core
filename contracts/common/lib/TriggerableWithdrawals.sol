// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;
library TriggerableWithdrawals {
    address constant WITHDRAWAL_REQUEST = 0x0c15F14308530b7CDB8460094BbB9cC28b9AaaAA;
    uint256 internal constant WITHDRAWAL_REQUEST_CALLDATA_LENGTH = 56;
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    uint256 internal constant WITHDRAWAL_AMOUNT_LENGTH = 8;

    error MismatchedArrayLengths(uint256 keysCount, uint256 amountsCount);
    error InsufficientBalanceForWithdrawalFee(uint256 balance, uint256 totalWithdrawalFee);
    error InsufficientRequestFee(uint256 feePerRequest, uint256 minFeePerRequest);

    error WithdrawalRequestFeeReadFailed();
    error WithdrawalRequestAdditionFailed(bytes callData);
    error NoWithdrawalRequests();
    error PartialWithdrawalRequired(uint256 index);
    error InvalidPublicKeyLength();

    /**
     * @dev Adds full withdrawal requests for the provided public keys.
     *      The validator will fully withdraw and exit its duties as a validator.
     * @param pubkeys An array of public keys for the validators requesting full withdrawals.
     */
    function addFullWithdrawalRequests(bytes calldata pubkeys, uint256 feePerRequest) internal {
        uint256 keysCount = _validateAndCountPubkeys(pubkeys);
        feePerRequest = _validateAndAdjustFee(feePerRequest, keysCount);

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
     * @dev Adds partial withdrawal requests for the provided public keys with corresponding amounts.
     *      A partial withdrawal is any withdrawal where the amount is greater than zero.
     *      A full withdrawal is any withdrawal where the amount is zero.
     *      This allows withdrawal of any balance exceeding 32 ETH (e.g., if a validator has 35 ETH, up to 3 ETH can be withdrawn).
     *      However, the protocol enforces a minimum balance of 32 ETH per validator, even if a higher amount is requested.
     * @param pubkeys An array of public keys for the validators requesting withdrawals.
     * @param amounts An array of corresponding withdrawal amounts for each public key.
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
     * @dev Adds partial or full withdrawal requests for the provided public keys with corresponding amounts.
     *      A partial withdrawal is any withdrawal where the amount is greater than zero.
     *      This allows withdrawal of any balance exceeding 32 ETH (e.g., if a validator has 35 ETH, up to 3 ETH can be withdrawn).
     *      However, the protocol enforces a minimum balance of 32 ETH per validator, even if a higher amount is requested.
     * @param pubkeys An array of public keys for the validators requesting withdrawals.
     * @param amounts An array of corresponding withdrawal amounts for each public key.
     */
    function addWithdrawalRequests(bytes calldata pubkeys, uint64[] calldata amounts, uint256 feePerRequest) internal {
        uint256 keysCount = _validateAndCountPubkeys(pubkeys);

        if (keysCount != amounts.length) {
            revert MismatchedArrayLengths(keysCount, amounts.length);
        }

        feePerRequest = _validateAndAdjustFee(feePerRequest, keysCount);

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
     * @dev Retrieves the current withdrawal request fee.
     * @return The minimum fee required per withdrawal request.
     */
    function getWithdrawalRequestFee() internal view returns (uint256) {
        (bool success, bytes memory feeData) = WITHDRAWAL_REQUEST.staticcall("");

        if (!success) {
            revert WithdrawalRequestFeeReadFailed();
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
            revert InvalidPublicKeyLength();
        }

        uint256 keysCount = pubkeys.length / PUBLIC_KEY_LENGTH;
        if (keysCount == 0) {
            revert NoWithdrawalRequests();
        }

        return keysCount;
    }

    function _validateAndAdjustFee(uint256 feePerRequest, uint256 keysCount) private view returns (uint256) {
        uint256 minFeePerRequest = getWithdrawalRequestFee();

        if (feePerRequest == 0) {
            feePerRequest = minFeePerRequest;
        }

        if (feePerRequest < minFeePerRequest) {
            revert InsufficientRequestFee(feePerRequest, minFeePerRequest);
        }

        if (address(this).balance < feePerRequest * keysCount) {
            revert InsufficientBalanceForWithdrawalFee(address(this).balance, feePerRequest * keysCount);
        }

        return feePerRequest;
    }
}
