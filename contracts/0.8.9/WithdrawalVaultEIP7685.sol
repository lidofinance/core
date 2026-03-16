// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;


/**
 * @title Withdrawal Vault EIP-7685 Support
 * @notice Abstract contract providing base functionality for
 *         general-purpose Execution Layer requests.
 * @dev Implements support for the following request types:
 *      - EIP-7002: Withdrawal requests
 *      - EIP-7251: Consolidation requests
 */
abstract contract WithdrawalVaultEIP7685 {
    address public immutable WITHDRAWAL_REQUEST;
    address public immutable CONSOLIDATION_REQUEST;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    event WithdrawalRequestAdded(bytes request);
    event ConsolidationRequestAdded(bytes request);

    error ZeroAddress();
    error ZeroArgument(string name);
    error ArraysLengthMismatch(uint256 firstArrayLength, uint256 secondArrayLength);
    error FeeReadFailed();
    error FeeInvalidData();
    error IncorrectFee(uint256 requiredFee, uint256 providedFee);
    error RequestAdditionFailed(bytes callData);
    error InvalidPublicKeyLength(bytes pubkey);

    constructor(address _withdrawalRequest, address _consolidationRequest) {
        _onlyNonZeroAddress(_withdrawalRequest);
        _onlyNonZeroAddress(_consolidationRequest);

        WITHDRAWAL_REQUEST = _withdrawalRequest;
        CONSOLIDATION_REQUEST = _consolidationRequest;
    }

    function _addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts) internal {
        uint256 requestsCount = pubkeys.length;
        if (requestsCount == 0) revert ZeroArgument("pubkeys");
        if (requestsCount != amounts.length) revert ArraysLengthMismatch(requestsCount, amounts.length);

        uint256 fee = _getWithdrawalRequestFee();
        _requireExactFee(requestsCount * fee);

        for (uint256 i = 0; i < requestsCount; ++i) {
            _validatePublicKey(pubkeys[i]);
            _callAddWithdrawalRequest(pubkeys[i], amounts[i], fee);
        }
    }

    function _addConsolidationRequests(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys
    ) internal {
        uint256 requestsCount = sourcePubkeys.length;
        if (requestsCount == 0) revert ZeroArgument("sourcePubkeys");
        if (requestsCount != targetPubkeys.length)
            revert ArraysLengthMismatch(requestsCount, targetPubkeys.length);

        uint256 fee = _getConsolidationRequestFee();
        _requireExactFee(requestsCount * fee);

        for (uint256 i = 0; i < requestsCount; ++i) {
            _validatePublicKey(sourcePubkeys[i]);
            _validatePublicKey(targetPubkeys[i]);
            _callAddConsolidationRequest(sourcePubkeys[i], targetPubkeys[i], fee);
        }
    }

    function _getWithdrawalRequestFee() internal view returns (uint256) {
        return _getFeeFromContract(WITHDRAWAL_REQUEST);
    }

    function _getConsolidationRequestFee() internal view returns (uint256) {
        return _getFeeFromContract(CONSOLIDATION_REQUEST);
    }

    function _getFeeFromContract(address contractAddress) internal view returns (uint256) {
        (bool success, bytes memory feeData) = contractAddress.staticcall("");

        if (!success) {
            revert FeeReadFailed();
        }

        if (feeData.length != 32) {
            revert FeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function _validatePublicKey(bytes calldata pubkey) internal pure {
        if (pubkey.length != PUBLIC_KEY_LENGTH) {
            revert InvalidPublicKeyLength(pubkey);
        }
    }

    function _callAddWithdrawalRequest(bytes calldata pubkey, uint64 amount, uint256 fee) internal {
        bytes memory request = abi.encodePacked(pubkey, amount);
        (bool success,) = WITHDRAWAL_REQUEST.call{value: fee}(request);
        if (!success) {
            revert RequestAdditionFailed(request);
        }

        emit WithdrawalRequestAdded(request);
    }

    function _callAddConsolidationRequest(bytes calldata sourcePubkey, bytes calldata targetPubkey, uint256 fee) internal {
        bytes memory request = abi.encodePacked(sourcePubkey, targetPubkey);
        (bool success,) = CONSOLIDATION_REQUEST.call{value: fee}(request);
        if (!success) {
            revert RequestAdditionFailed(request);
        }

        emit ConsolidationRequestAdded(request);
    }

    function _requireExactFee(uint256 requiredFee) internal view {
        if (requiredFee != msg.value) {
            revert IncorrectFee(requiredFee, msg.value);
        }
    }

    function _onlyNonZeroAddress(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }
}
