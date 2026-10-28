// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ITriggerableWithdrawalsGateway} from "contracts/common/interfaces/ITriggerableWithdrawalsGateway.sol";
import {WithdrawalIntent, MAX_PWR_AMOUNT_GWEI} from "contracts/common/interfaces/WithdrawalIntent.sol";
import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";

import {WithdrawalLimit, WithdrawalLimitData} from "contracts/0.8.25/lib/WithdrawalLimit.sol";

interface IWithdrawalVault {
    function addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}

/**
 * @title TriggerableWithdrawalsGateway
 * @author Lido
 * @notice Single entry point for all EIP-7002 withdrawal requests (partial and full) in the protocol.
 *         Forwards requests to the WithdrawalVault and limits them per caller (consumer):
 *         partial withdrawals (PWRs) by the requested balance in gwei, full withdrawals (FWRs) by their number.
 *         A consumer without limits cannot submit requests, so the limits are also the list of allowed callers.
 */
contract TriggerableWithdrawalsGateway is ITriggerableWithdrawalsGateway, AccessControlEnumerable, PausableUntil {
    using WithdrawalLimit for WithdrawalLimitData;

    /// @dev Quotas of one consumer, one storage slot each
    struct ConsumerLimits {
        WithdrawalLimitData pwr; // in gwei
        WithdrawalLimitData fwr; // in validators
    }

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 public constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");

    ILidoLocator public immutable LOCATOR;

    mapping(address consumer => ConsumerLimits) internal _consumerLimits;

    /// @dev Ensures the contract's ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    constructor(address admin, address lidoLocator) {
        if (admin == address(0)) revert ZeroArgument("admin");
        if (lidoLocator == address(0)) revert ZeroArgument("lidoLocator");
        LOCATOR = ILidoLocator(lidoLocator);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @notice Resume the contract
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pause the contract for a specified period
     * @param _duration pause duration in seconds (use `PAUSE_INFINITELY` for unlimited)
     */
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /**
     * @notice Pause the contract until a specified timestamp
     * @param _pauseUntilInclusive the last second to pause until inclusive
     */
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /**
     * @notice Submits withdrawal requests for all `intents` in order to the WithdrawalVault.
     *         A partial withdrawal consumes its amount from the caller's PWR limit,
     *         a full withdrawal consumes one unit from the caller's FWR limit.
     * @param intents Withdrawal intents: `amount == 0` is a full withdrawal, `amount > 0` is a partial one (gwei)
     * @param refundRecipient Receiver of the unused fee; `address(0)` refunds to `msg.sender`
     */
    function triggerWithdrawals(
        WithdrawalIntent[] calldata intents,
        address refundRecipient
    ) external payable preservesEthBalance whenResumed {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        uint256 requestsCount = intents.length;
        if (requestsCount == 0) revert ZeroArgument("intents");

        bytes[] memory pubkeys = new bytes[](requestsCount);
        uint64[] memory amounts = new uint64[](requestsCount);
        uint256 pwrAmountGwei = 0;
        uint256 fwrCount = 0;

        for (uint256 i = 0; i < requestsCount; ++i) {
            uint64 amount = intents[i].amount;
            pubkeys[i] = intents[i].pubkey;
            amounts[i] = amount;

            if (amount == 0) {
                ++fwrCount;
            } else {
                pwrAmountGwei += amount;
            }
        }

        _consumeLimits(msg.sender, pwrAmountGwei, fwrCount);

        IWithdrawalVault withdrawalVault = IWithdrawalVault(LOCATOR.withdrawalVault());
        uint256 totalFee = requestsCount * withdrawalVault.getWithdrawalRequestFee();
        uint256 refund = _checkFee(totalFee);

        withdrawalVault.addWithdrawalRequests{value: totalFee}(pubkeys, amounts);

        emit WithdrawalsTriggered(msg.sender, requestsCount - fwrCount, pwrAmountGwei, fwrCount);

        _refundFee(refund, refundRecipient);
    }

    /**
     * @notice Sets the limits of a consumer. An enabled limit keeps the quota restored so far,
     *         capped by the new maximum; a limit that was disabled starts full.
     * @param consumer Caller address the limits apply to
     * @param pwrLimit PWR quota, in gwei: all zero disables partial withdrawals,
     *        otherwise the maximum is at least MAX_PWR_AMOUNT_GWEI
     * @param fwrLimit FWR quota, in validators: all zero disables full withdrawals
     */
    function setConsumerLimits(
        address consumer,
        LimitConfig calldata pwrLimit,
        LimitConfig calldata fwrLimit
    ) external onlyRole(TW_EXIT_LIMIT_MANAGER_ROLE) {
        if (consumer == address(0)) revert ZeroArgument("consumer");
        // A lower maximum would leave a queued partial withdrawal of the max amount unable to ever fit
        if (pwrLimit.maxLimit != 0 && pwrLimit.maxLimit < MAX_PWR_AMOUNT_GWEI) {
            revert TooSmallMaxPwrLimit(pwrLimit.maxLimit);
        }

        ConsumerLimits storage limits = _consumerLimits[consumer];
        uint256 timestamp = _getTimestamp();

        limits.pwr = limits.pwr.setLimits(
            pwrLimit.maxLimit,
            pwrLimit.limitPerFrame,
            pwrLimit.frameDurationInSec,
            timestamp
        );
        limits.fwr = limits.fwr.setLimits(
            fwrLimit.maxLimit,
            fwrLimit.limitPerFrame,
            fwrLimit.frameDurationInSec,
            timestamp
        );

        emit ConsumerLimitsSet(consumer, pwrLimit, fwrLimit);
    }

    /**
     * @notice Returns the limits of a consumer, all zero if they are not set
     * @param consumer Caller address the limits apply to
     * @return pwrLimit PWR quota, in gwei
     * @return fwrLimit FWR quota, in validators
     */
    function getConsumerLimitsFullInfo(
        address consumer
    ) external view returns (LimitInfo memory pwrLimit, LimitInfo memory fwrLimit) {
        ConsumerLimits storage limits = _consumerLimits[consumer];
        uint256 timestamp = _getTimestamp();

        pwrLimit = _getLimitInfo(limits.pwr, timestamp);
        fwrLimit = _getLimitInfo(limits.fwr, timestamp);
    }

    function _checkFee(uint256 fee) internal view returns (uint256 refund) {
        if (msg.value < fee) {
            revert InsufficientFee(fee, msg.value);
        }
        unchecked {
            refund = msg.value - fee;
        }
    }

    function _refundFee(uint256 refund, address recipient) internal {
        if (refund > 0) {
            if (recipient == address(0)) {
                recipient = msg.sender;
            }

            (bool success, ) = recipient.call{value: refund}("");
            if (!success) {
                revert FeeRefundFailed();
            }
        }
    }

    function _getTimestamp() internal view virtual returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    /// @dev Consumes only the quotas a batch uses, so a disabled quota blocks only its own kind of requests
    function _consumeLimits(address consumer, uint256 pwrAmountGwei, uint256 fwrCount) internal {
        ConsumerLimits storage limits = _consumerLimits[consumer];
        uint256 timestamp = _getTimestamp();

        if (pwrAmountGwei > 0) {
            WithdrawalLimitData memory pwrLimit = limits.pwr;
            uint256 currentPwrLimitGwei = pwrLimit.calculateCurrentLimit(timestamp);
            if (pwrAmountGwei > currentPwrLimitGwei) revert PwrLimitExceeded(pwrAmountGwei, currentPwrLimitGwei);

            limits.pwr = pwrLimit.updatePrevLimit(currentPwrLimitGwei - pwrAmountGwei, timestamp);
        }

        if (fwrCount > 0) {
            WithdrawalLimitData memory fwrLimit = limits.fwr;
            uint256 currentFwrLimit = fwrLimit.calculateCurrentLimit(timestamp);
            if (fwrCount > currentFwrLimit) revert FwrLimitExceeded(fwrCount, currentFwrLimit);

            limits.fwr = fwrLimit.updatePrevLimit(currentFwrLimit - fwrCount, timestamp);
        }
    }

    function _getLimitInfo(
        WithdrawalLimitData memory data,
        uint256 timestamp
    ) internal pure returns (LimitInfo memory) {
        return
            LimitInfo({
                maxLimit: data.maxLimit,
                limitPerFrame: data.limitPerFrame,
                frameDurationInSec: data.frameDurationInSec,
                prevLimit: data.prevLimit,
                currentLimit: data.calculateCurrentLimit(timestamp)
            });
    }

    /**
     * @notice Emitted when withdrawal requests are submitted
     * @param consumer Address that submitted the requests
     * @param pwrCount Number of partial withdrawal requests
     * @param pwrAmountGwei Total amount of the partial withdrawal requests, in gwei
     * @param fwrCount Number of full withdrawal requests
     */
    event WithdrawalsTriggered(address indexed consumer, uint256 pwrCount, uint256 pwrAmountGwei, uint256 fwrCount);

    /**
     * @notice Emitted when the limits of a consumer are set
     * @param consumer Caller address the limits apply to
     * @param pwrLimit PWR quota, in gwei
     * @param fwrLimit FWR quota, in validators
     */
    event ConsumerLimitsSet(address indexed consumer, LimitConfig pwrLimit, LimitConfig fwrLimit);

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when the passed fee is insufficient to cover all requests
     * @param feeRequired Fee required to cover all requests
     * @param passedValue Fee passed with the call
     */
    error InsufficientFee(uint256 feeRequired, uint256 passedValue);

    /**
     * @notice Thrown when the fee refund failed
     */
    error FeeRefundFailed();

    /**
     * @notice Thrown when the remaining PWR limit of the caller is not enough for the partial withdrawals
     * @param requestedGwei Total amount of the partial withdrawals in gwei
     * @param remainingGwei Remaining PWR limit in gwei
     */
    error PwrLimitExceeded(uint256 requestedGwei, uint256 remainingGwei);

    /**
     * @notice Thrown when the remaining FWR limit of the caller is not enough for the full withdrawals
     * @param requested Number of full withdrawals
     * @param remaining Remaining FWR limit in validators
     */
    error FwrLimitExceeded(uint256 requested, uint256 remaining);

    /**
     * @notice Thrown when an enabled PWR limit has a maximum below MAX_PWR_AMOUNT_GWEI
     * @param maxLimitGwei Passed maximum PWR limit in gwei
     */
    error TooSmallMaxPwrLimit(uint256 maxLimitGwei);
}
