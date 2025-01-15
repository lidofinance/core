// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

library TriggerableWithdrawals {
    address constant WITHDRAWAL_REQUEST = 0x0c15F14308530b7CDB8460094BbB9cC28b9AaaAA;

    error MismatchedArrayLengths(uint256 keysCount, uint256 amountsCount);
    error InsufficientBalance(uint256 balance, uint256 totalWithdrawalFee);
    error FeeNotEnough(uint256 minFeePerRequest, uint256 requestCount, uint256 providedTotalFee);

    error WithdrawalRequestFeeReadFailed();
    error InvalidPubkeyLength(bytes pubkey);
    error WithdrawalRequestAdditionFailed(bytes pubkey, uint256 amount);
    error NoWithdrawalRequests();
    error PartialWithdrawalRequired(bytes pubkey);

    event WithdrawalRequestAdded(bytes pubkey, uint256 amount);

    /**
     * @dev Adds full withdrawal requests for the provided public keys.
     *      The validator will fully withdraw and exit its duties as a validator.
     * @param pubkeys An array of public keys for the validators requesting full withdrawals.
     */
    function addFullWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint256 totalWithdrawalFee
    ) internal {
        uint64[] memory amounts = new uint64[](pubkeys.length);
        _addWithdrawalRequests(pubkeys, amounts, totalWithdrawalFee);
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
        bytes[] calldata pubkeys,
        uint64[] calldata amounts,
        uint256 totalWithdrawalFee
    ) internal {
        _requireArrayLengthsMatch(pubkeys, amounts);

        for (uint256 i = 0; i < amounts.length; i++) {
            if (amounts[i] == 0) {
                revert PartialWithdrawalRequired(pubkeys[i]);
            }
        }

        _addWithdrawalRequests(pubkeys, amounts, totalWithdrawalFee);
    }

        /**
     * @dev Adds partial or full withdrawal requests for the provided public keys with corresponding amounts.
     *      A partial withdrawal is any withdrawal where the amount is greater than zero.
     *      This allows withdrawal of any balance exceeding 32 ETH (e.g., if a validator has 35 ETH, up to 3 ETH can be withdrawn).
     *      However, the protocol enforces a minimum balance of 32 ETH per validator, even if a higher amount is requested.
     * @param pubkeys An array of public keys for the validators requesting withdrawals.
     * @param amounts An array of corresponding withdrawal amounts for each public key.
     */
    function addWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts,
        uint256 totalWithdrawalFee
    ) internal {
        _requireArrayLengthsMatch(pubkeys, amounts);
        _addWithdrawalRequests(pubkeys, amounts, totalWithdrawalFee);
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

    function _addWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] memory amounts,
        uint256 totalWithdrawalFee
    ) internal {
        uint256 keysCount = pubkeys.length;
        if (keysCount == 0) {
            revert NoWithdrawalRequests();
        }

        if(address(this).balance < totalWithdrawalFee) {
            revert InsufficientBalance(address(this).balance, totalWithdrawalFee);
        }

        uint256 minFeePerRequest = getWithdrawalRequestFee();
        if (minFeePerRequest * keysCount > totalWithdrawalFee) {
            revert FeeNotEnough(minFeePerRequest, keysCount, totalWithdrawalFee);
        }

        uint256 feePerRequest = totalWithdrawalFee / keysCount;
        uint256 unallocatedFee = totalWithdrawalFee % keysCount;
        uint256 prevBalance = address(this).balance - totalWithdrawalFee;

        for (uint256 i = 0; i < keysCount; ++i) {
            if(pubkeys[i].length != 48) {
                revert InvalidPubkeyLength(pubkeys[i]);
            }

            uint256 feeToSend = feePerRequest;

            if (i == keysCount - 1) {
                feeToSend += unallocatedFee;
            }

            bytes memory callData = abi.encodePacked(pubkeys[i], amounts[i]);
            (bool success, ) = WITHDRAWAL_REQUEST.call{value: feeToSend}(callData);

            if (!success) {
                revert WithdrawalRequestAdditionFailed(pubkeys[i], amounts[i]);
            }

            emit WithdrawalRequestAdded(pubkeys[i], amounts[i]);
        }

        assert(address(this).balance == prevBalance);
    }

    function _requireArrayLengthsMatch(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts
    ) internal pure {
        if (pubkeys.length != amounts.length) {
            revert MismatchedArrayLengths(pubkeys.length, amounts.length);
        }
    }
}
