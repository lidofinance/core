// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

/**
 * @title A base contract for a withdrawal vault implementing EIP-7685: General Purpose Execution Layer Requests
 * @dev This contract enables validators to submit EIP-7002 withdrawal requests.
 */
abstract contract WithdrawalVaultEIP7685 {
    address constant WITHDRAWAL_REQUEST = 0x00000961Ef480Eb55e80D19ad83579A64c007002;

    event WithdrawalRequestAdded(bytes request);

    error ZeroArgument(string name);
    error ArraysLengthMismatch(uint256 firstArrayLength, uint256 secondArrayLength);
    error FeeReadFailed();
    error FeeInvalidData();
    error IncorrectFee(uint256 providedFee, uint256 requiredFee);
    error RequestAdditionFailed(bytes callData);

    /**
     * @dev Submits EIP-7002 full or partial withdrawal requests for the specified public keys.
     *      Each full withdrawal request instructs a validator to fully withdraw its stake and exit its duties as a validator.
     *      Each partial withdrawal request instructs a validator to withdraw a specified amount of ETH.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting partial withdrawals.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param amounts An array of 8-byte unsigned integers representing the amounts to be withdrawn for each corresponding public key.
     *                For full withdrawal requests, the amount should be set to 0.
     *                For partial withdrawal requests, the amount should be greater than 0.
     *
     * @notice Reverts if:
     *         - The caller does not have the `ADD_WITHDRAWAL_REQUEST_ROLE`.
     *         - The provided public key array is empty.
     *         - The provided public key array malformed.
     *         - The provided public key and amount arrays are not of equal length.
     *         - The provided total withdrawal fee value is invalid.
     */
    function _addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts) internal {
        uint256 requestsCount = pubkeys.length;
        if (requestsCount == 0) revert ZeroArgument("pubkeys");
        if (requestsCount != amounts.length) revert ArraysLengthMismatch(requestsCount, amounts.length);

        uint256 fee = getWithdrawalRequestFee();
        _checkFee(requestsCount * fee);

        for (uint256 i = 0; i < requestsCount; ++i) {
            _callAddWithdrawalRequest(pubkeys[i], amounts[i], fee);
        }
    }

    /**
     * @dev Retrieves the current EIP-7002 withdrawal fee.
     * @return The minimum fee required per withdrawal request.
     */
    function getWithdrawalRequestFee() public view returns (uint256) {
        return _getRequestFee(WITHDRAWAL_REQUEST);
    }

    function _getRequestFee(address requestedContract) internal view returns (uint256) {
        (bool success, bytes memory feeData) = requestedContract.staticcall("");

        if (!success) {
            revert FeeReadFailed();
        }

        if (feeData.length != 32) {
            revert FeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    // function _callAddWithdrawalRequest(uint256 fee, bytes memory request) internal {
    function _callAddWithdrawalRequest(bytes calldata pubkey, uint64 amount, uint256 fee) internal {
        assert(pubkey.length == 48);

        bytes memory request = abi.encodePacked(pubkey, amount);
        (bool success,) = WITHDRAWAL_REQUEST.call{value: fee}(request);
        if (!success) {
            revert RequestAdditionFailed(request);
        }

        emit WithdrawalRequestAdded(request);
    }

    function _checkFee(uint256 fee) internal view {
        if (msg.value != fee) {
            revert IncorrectFee(msg.value, fee);
        }
    }
}
