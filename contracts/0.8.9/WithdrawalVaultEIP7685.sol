// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {PausableUntil} from "./utils/PausableUntil.sol";

import {TriggerableWithdrawals} from "../common/lib/TriggerableWithdrawals.sol";
import {Eip7251MaxEffectiveBalance} from "../common/lib/Eip7251MaxEffectiveBalance.sol";

/**
 * @title A base contract for a withdrawal vault implementing EIP-7685: General Purpose Execution Layer Requests
 * @dev This contract enables validators to submit EIP-7002 withdrawal requests
 *      and manages the associated fees.
 */
abstract contract WithdrawalVaultEIP7685 is AccessControlEnumerable, PausableUntil {
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 public constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
    bytes32 public constant ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE");
    bytes32 public constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");

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
     * @dev Resumes the general purpose execution layer requests.
     * @notice Reverts if:
     *         - The contract is not paused.
     *         - The sender does not have the `RESUME_ROLE`.
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pauses the general purpose execution layer requests placement for a specified duration.
     * @param _duration The pause duration in seconds (use `PAUSE_INFINITELY` for unlimited).
     * @dev Reverts if:
     *         - The contract is already paused.
     *         - The sender does not have the `PAUSE_ROLE`.
     *         - A zero duration is passed.
     */
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /**
     * @notice Pauses the general purpose execution layer requests placement until a specified timestamp.
     * @param _pauseUntilInclusive The last second to pause until (inclusive).
     * @dev Reverts if:
     *         - The timestamp is in the past.
     *         - The sender does not have the `PAUSE_ROLE`.
     *         - The contract is already paused.
     */
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
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
    ) external payable onlyRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE) whenResumed preservesEthBalance {
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
    ) external payable onlyRole(ADD_PARTIAL_WITHDRAWAL_REQUEST_ROLE) whenResumed preservesEthBalance {
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

    /**
     * @dev Submits EIP-7251 consolidation requests for the specified public keys.
     *      Each request consolidate validators.
     *      Refunds any excess fee to the caller after deducting the total fees,
     *      which are calculated based on the number of requests and the current minimum fee per withdrawal request.
     *
     * @param sourcePubkeys A tightly packed array of 48-byte source public keys corresponding to validators requesting consolidation.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param targetPubkeys A tightly packed array of 48-byte target public keys corresponding to validators requesting consolidation.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @notice Reverts if:
     *         - The caller does not have the `ADD_CONSOLIDATION_REQUEST_ROLE`.
     *         - Validation of any of the provided public keys fails.
     *         - The source and target public key arrays have different lengths.
     *         - The provided public key arrays are empty.
     *         - The provided total consolidation fee is insufficient to cover all requests.
     *         - Refund of the excess fee fails.
     */
    function addConsolidationRequests(
        bytes calldata sourcePubkeys,
        bytes calldata targetPubkeys
    ) external payable onlyRole(ADD_CONSOLIDATION_REQUEST_ROLE) whenResumed preservesEthBalance {
        uint256 feePerRequest = Eip7251MaxEffectiveBalance.getConsolidationRequestFee();
        uint256 totalFee = _countPubkeys(sourcePubkeys) * feePerRequest;

        _requireSufficientFee(totalFee);

        Eip7251MaxEffectiveBalance.addConsolidationRequests(sourcePubkeys, targetPubkeys, feePerRequest);

        _refundExcessFee(totalFee);
    }

    /**
     * @dev Retrieves the current EIP-7251 consolidation fee.
     * @return The minimum fee required per consolidation request.
     */
    function getConsolidationRequestFee() external view returns (uint256) {
        return Eip7251MaxEffectiveBalance.getConsolidationRequestFee();
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
