// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

/**
 * @notice A withdrawal request intention: not yet an EIP-7002 request, becomes one once executed
 *         through the TriggerableWithdrawalsGateway.
 * @param amount Amount to withdraw in gwei: `0` for a full withdrawal (FWR), `> 0` for a partial withdrawal (PWR)
 * @param pubkey Validator public key, 48 bytes
 */
struct WithdrawalIntent {
    uint64 amount;
    bytes pubkey;
}

/// @dev Weight of a full withdrawal in the gateway limit, in ETH (max effective balance of a 0x02 validator)
uint256 constant FULL_WITHDRAWAL_WEIGHT_ETH = 2048;

/// @dev Max partial withdrawal amount in gwei, so no intent weighs more than a full withdrawal
uint256 constant MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI = FULL_WITHDRAWAL_WEIGHT_ETH * 1e9;
