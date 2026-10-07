// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

import {WithdrawalIntent} from "contracts/common/interfaces/WithdrawalIntent.sol";

/**
 * @title ITriggerableWithdrawalsBus
 * @notice FIFO queue of withdrawal intents appended by the TriggerableWithdrawalsOracle
 *         and executed permissionlessly through the TriggerableWithdrawalsGateway
 */
interface ITriggerableWithdrawalsBus {
    /**
     * @notice Appends `intents` to the tail of the queue, preserving their order.
     * @param intents Withdrawal intents to enqueue
     */
    function addWithdrawalIntents(WithdrawalIntent[] calldata intents) external;

    /**
     * @notice Pops up to `count` intents from the head of the queue and executes them as withdrawal requests.
     * @param count Maximum number of intents to process
     * @param refundRecipient Receiver of the unused fee; `address(0)` refunds to `msg.sender`
     * @return processedCount Number of intents processed, less than `count` if the queue holds fewer intents
     */
    function processWithdrawalIntents(
        uint256 count,
        address refundRecipient
    ) external payable returns (uint256 processedCount);

    /**
     * @notice Returns the number of intents waiting in the queue.
     */
    function unprocessedIntentsCount() external view returns (uint256);

    /**
     * @notice Returns up to `limit` queued intents starting at `offset` in execution order.
     * @param offset Position in the queue, `0` is the next intent to be processed
     * @param limit Maximum number of intents to return
     */
    function getWithdrawalIntents(uint256 offset, uint256 limit) external view returns (WithdrawalIntent[] memory);
}
