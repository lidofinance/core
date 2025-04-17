// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";

import {TriggerableWithdrawals} from "../common/lib/TriggerableWithdrawals.sol";

/**
 * @title A base contract for a withdrawal vault implementing EIP-7685: General Purpose Execution Layer Requests
 * @dev This contract enables validators to submit EIP-7002 withdrawal requests
 *      and manages the associated fees.
 */
abstract contract WithdrawalVaultEIP7685 is AccessControlEnumerable {
    bytes32 public constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
    bytes32 public constant ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE");

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    error InsufficientFee(uint256 providedFee, uint256 requiredFee);
    error ExcessFeeRefundFailed();

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    /**
     * @dev Submits EIP-7002 full withdrawal requests for the specified public keys.
     *      Each request instructs a validator to fully withdraw its stake and exit its duties as a validator.
     *      Refunds any excess fee to the caller after deducting the total fees,
     *      which are calculated based on the number of public keys and the current minimum fee per withdrawal request.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting full withdrawals.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @notice Reverts if:
     *         - The caller does not have the `ADD_FULL_WITHDRAWAL_REQUEST_ROLE`.
     *         - The provided public key array is empty.
     *         - Validation of any of the provided public keys fails.
     *         - The provided total withdrawal fee is insufficient to cover all requests.
     *         - Refund of the excess fee fails.
     */
    function addFullWithdrawalRequests(
        bytes calldata pubkeys
    ) external payable onlyRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE) preservesEthBalance {
        uint256 feePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        uint256 totalFee = _countPubkeys(pubkeys) * feePerRequest;

        _requireSufficientFee(totalFee);

        TriggerableWithdrawals.addFullWithdrawalRequests(pubkeys, feePerRequest);

        _refundExcessFee(totalFee);
    }

    /**
     * @dev Submits EIP-7002 partial withdrawal requests for the specified public keys with corresponding amounts.
     *      Each request instructs a validator to withdraw a specified amount of ETH via their execution layer (0x01) withdrawal credentials.
     *      Refunds any excess fee to the caller after deducting the total fees,
     *      which are calculated based on the number of public keys and the current minimum fee per withdrawal request.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting partial withdrawals.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param amounts An array of 8-byte unsigned integers representing the amounts to be withdrawn for each corresponding public key.
     *
     * @notice Reverts if:
     *         - The caller does not have the `ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE`.
     *         - The provided public key array is empty.
     *         - The provided public key and amount arrays are not of equal length.
     *         - Full withdrawal requested for any pubkeys (withdrawal amount = 0).
     *         - Validation of any of the provided public keys fails.
     *         - The provided total withdrawal fee is insufficient to cover all requests.
     *         - Refund of the excess fee fails.
     */
    function addPartialWithdrawalRequests(
        bytes calldata pubkeys,
        uint64[] calldata amounts
    ) external payable onlyRole(ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE) preservesEthBalance {
        uint256 feePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        uint256 totalFee = _countPubkeys(pubkeys) * feePerRequest;

        _requireSufficientFee(totalFee);

        TriggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, feePerRequest);

        _refundExcessFee(totalFee);
    }

    /**
     * @dev Retrieves the current EIP-7002 withdrawal fee.
     * @return The minimum fee required per withdrawal request.
     */
    function getWithdrawalRequestFee() external view returns (uint256) {
        return TriggerableWithdrawals.getWithdrawalRequestFee();
    }

    function _countPubkeys(bytes calldata pubkeys) internal pure returns (uint256) {
        return (pubkeys.length / PUBLIC_KEY_LENGTH);
    }

    function _requireSufficientFee(uint256 requiredFee) internal view {
        if (requiredFee > msg.value) {
            revert InsufficientFee(msg.value, requiredFee);
        }
    }

    function _refundExcessFee(uint256 fee) internal {
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool success, ) = msg.sender.call{value: refund}("");

            if (!success) {
                revert ExcessFeeRefundFailed();
            }
        }
    }
}
