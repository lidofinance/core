// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

import {WithdrawalIntent} from "contracts/common/interfaces/WithdrawalIntent.sol";

/**
 * @title ITriggerableWithdrawalsGateway
 * @notice Single entry point for all EIP-7002 withdrawal requests (partial and full) in the protocol
 */
interface ITriggerableWithdrawalsGateway {
    /**
     * @notice Submits withdrawal requests for all `intents` in order.
     * @param intents Withdrawal intents: `amount == 0` is a full withdrawal, `amount > 0` is a partial one (gwei)
     * @param refundRecipient Receiver of the unused fee; `address(0)` refunds to `msg.sender`
     * @dev Reverts if the total weight of `intents` exceeds the remaining limit (no partial processing).
     */
    function triggerWithdrawals(WithdrawalIntent[] calldata intents, address refundRecipient) external payable;
}
