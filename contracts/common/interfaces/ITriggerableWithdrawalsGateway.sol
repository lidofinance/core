// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

import {WithdrawalIntent} from "contracts/common/interfaces/WithdrawalIntent.sol";

/**
 * @title ITriggerableWithdrawalsGateway
 * @notice Single entry point for all EIP-7002 withdrawal requests (partial and full) in the protocol.
 *         Each caller (consumer) has its own PWR limit, in gwei, and its own FWR limit, in validators.
 */
interface ITriggerableWithdrawalsGateway {
    /**
     * @notice Parameters of a replenishing quota; all fields are zero for a disabled quota
     * @param maxLimit Maximum quota that can be accumulated
     * @param limitPerFrame Quota restored per frame
     * @param frameDurationInSec Frame duration in seconds
     */
    struct LimitConfig {
        uint256 maxLimit;
        uint256 limitPerFrame;
        uint256 frameDurationInSec;
    }

    /**
     * @notice Parameters and state of a replenishing quota
     * @param maxLimit Maximum quota that can be accumulated
     * @param limitPerFrame Quota restored per frame
     * @param frameDurationInSec Frame duration in seconds
     * @param prevLimit Quota left after the last update
     * @param currentLimit Quota available now, `0` if the limit is not set
     */
    struct LimitInfo {
        uint256 maxLimit;
        uint256 limitPerFrame;
        uint256 frameDurationInSec;
        uint256 prevLimit;
        uint256 currentLimit;
    }

    /**
     * @notice Submits withdrawal requests for all `intents` in order.
     *         A partial withdrawal consumes its amount from the caller's PWR limit,
     *         a full withdrawal consumes one unit from the caller's FWR limit.
     * @param intents Withdrawal intents: `amount == 0` is a full withdrawal, `amount > 0` is a partial one (gwei)
     * @param refundRecipient Receiver of the unused fee; `address(0)` refunds to `msg.sender`
     * @dev Reverts if `intents` exceed either remaining limit of the caller (no partial processing).
     */
    function triggerWithdrawals(WithdrawalIntent[] calldata intents, address refundRecipient) external payable;

    /**
     * @notice Sets the limits of a consumer; a consumer without limits cannot submit requests.
     * @param consumer Caller address the limits apply to
     * @param pwrLimit PWR quota, in gwei; all zero disables partial withdrawals
     * @param fwrLimit FWR quota, in validators; all zero disables full withdrawals
     */
    function setConsumerLimits(address consumer, LimitConfig calldata pwrLimit, LimitConfig calldata fwrLimit) external;

    /**
     * @notice Returns the limits of a consumer
     * @param consumer Caller address the limits apply to
     * @return pwrLimit PWR quota, in gwei
     * @return fwrLimit FWR quota, in validators
     */
    function getConsumerLimitsFullInfo(
        address consumer
    ) external view returns (LimitInfo memory pwrLimit, LimitInfo memory fwrLimit);
}
