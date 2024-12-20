// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

library WithdrawalRequests {
    address constant WITHDRAWAL_REQUEST = 0x0c15F14308530b7CDB8460094BbB9cC28b9AaaAA;

    error MismatchedArrayLengths(uint256 keysCount, uint256 amountsCount);
    error FeeNotEnough(uint256 minFeePerRequest, uint256 requestCount, uint256 msgValue);

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
        bytes[] calldata pubkeys
    ) internal {
        uint256 keysCount = pubkeys.length;
        uint64[] memory amounts = new uint64[](keysCount);

        _addWithdrawalRequests(pubkeys, amounts);
    }

    /**
     * @dev Adds partial withdrawal requests for the provided public keys with corresponding amounts.
     *      A partial withdrawal is any withdrawal where the amount is greater than zero.
     *      This allows withdrawal of any balance exceeding 32 ETH (e.g., if a validator has 35 ETH, up to 3 ETH can be withdrawn).
     *      However, the protocol enforces a minimum balance of 32 ETH per validator, even if a higher amount is requested.
     * @param pubkeys An array of public keys for the validators requesting withdrawals.
     * @param amounts An array of corresponding withdrawal amounts for each public key.
     */
    function addPartialWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts
    ) internal {
        uint256 keysCount = pubkeys.length;
        if (keysCount != amounts.length) {
            revert MismatchedArrayLengths(keysCount, amounts.length);
        }

        uint64[] memory _amounts = new uint64[](keysCount);
        for (uint256 i = 0; i < keysCount; i++) {
            if (amounts[i] == 0) {
                revert PartialWithdrawalRequired(pubkeys[i]);
            }

            _amounts[i] = amounts[i];
        }

        _addWithdrawalRequests(pubkeys, _amounts);
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
        uint64[] memory amounts
    ) internal {
        uint256 keysCount = pubkeys.length;
        if (keysCount == 0) {
            revert NoWithdrawalRequests();
        }

        uint256 minFeePerRequest = getWithdrawalRequestFee();
        if (minFeePerRequest * keysCount > msg.value) {
            revert FeeNotEnough(minFeePerRequest, keysCount, msg.value);
        }

        uint256 feePerRequest = msg.value / keysCount;
        uint256 unallocatedFee = msg.value % keysCount;
        uint256 prevBalance = address(this).balance - msg.value;


        for (uint256 i = 0; i < keysCount; ++i) {
            bytes memory pubkey = pubkeys[i];
            uint64 amount = amounts[i];

            if(pubkey.length != 48) {
                revert InvalidPubkeyLength(pubkey);
            }

            uint256 feeToSend = feePerRequest;

            if (i == keysCount - 1) {
                feeToSend += unallocatedFee;
            }

            bytes memory callData = abi.encodePacked(pubkey, amount);
            (bool success, ) = WITHDRAWAL_REQUEST.call{value: feeToSend}(callData);

            if (!success) {
                revert WithdrawalRequestAdditionFailed(pubkey, amount);
            }

            emit WithdrawalRequestAdded(pubkey, amount);
        }

        assert(address(this).balance == prevBalance);
    }
}
