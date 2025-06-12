// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

/**
 * @title A base contract for a withdrawal vault, enables to submit EIP-7002 withdrawal requests.
 */
abstract contract WithdrawalVaultEIP7002 {
    address public constant WITHDRAWAL_REQUEST = 0x00000961Ef480Eb55e80D19ad83579A64c007002;

    event WithdrawalRequestAdded(bytes request);

    error ZeroArgument(string name);
    error ArraysLengthMismatch(uint256 firstArrayLength, uint256 secondArrayLength);
    error FeeReadFailed();
    error FeeInvalidData();
    error IncorrectFee(uint256 requiredFee, uint256 providedFee);
    error RequestAdditionFailed(bytes callData);

    function _addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts) internal {
        uint256 requestsCount = pubkeys.length;
        if (requestsCount == 0) revert ZeroArgument("pubkeys");
        if (requestsCount != amounts.length) revert ArraysLengthMismatch(requestsCount, amounts.length);

        uint256 fee = _getWithdrawalRequestFee();
        _checkFee(requestsCount * fee);

        for (uint256 i = 0; i < requestsCount; ++i) {
            _callAddWithdrawalRequest(pubkeys[i], amounts[i], fee);
        }
    }

    function _getWithdrawalRequestFee() internal view returns (uint256) {
        (bool success, bytes memory feeData) = WITHDRAWAL_REQUEST.staticcall("");

        if (!success) {
            revert FeeReadFailed();
        }

        if (feeData.length != 32) {
            revert FeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

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
            revert IncorrectFee(fee, msg.value);
        }
    }
}
