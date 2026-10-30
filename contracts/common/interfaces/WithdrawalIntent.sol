// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

/**
 * @notice A withdrawal request intent: not yet an EIP-7002 request, becomes one once executed
 *         through the TriggerableWithdrawalsGateway.
 * @param amount Amount to withdraw in gwei: `0` for a full withdrawal (FWR), `> 0` for a partial withdrawal (PWR)
 * @param pubkey Validator public key, 48 bytes
 */
struct WithdrawalIntent {
    uint64 amount;
    bytes pubkey;
}

/// @dev Max partial withdrawal amount in gwei: MAX_EFFECTIVE_BALANCE - MIN_ACTIVATION_BALANCE = 2048 - 32 = 2016 ETH.
///      No partial withdrawal needs more, and every enabled gateway PWR limit can hold at least this amount.
uint256 constant MAX_PWR_AMOUNT_GWEI = 2016 * 1e9;
