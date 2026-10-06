// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ITriggerableWithdrawalsGateway} from "contracts/common/interfaces/ITriggerableWithdrawalsGateway.sol";
import {
    WithdrawalIntent,
    FULL_WITHDRAWAL_WEIGHT_ETH,
    MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI
} from "contracts/common/interfaces/WithdrawalIntent.sol";
import {LimitData, RateLimitStorage, RateLimit} from "contracts/common/lib/RateLimit.sol";
import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";

interface IWithdrawalVault {
    function addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}

/**
 * @title TriggerableWithdrawalsGateway
 * @author Lido
 * @notice Single entry point for all EIP-7002 withdrawal requests (partial and full) in the protocol.
 *         Limits the total balance requested to be withdrawn per frame and forwards requests to the WithdrawalVault.
 */
contract TriggerableWithdrawalsGateway is ITriggerableWithdrawalsGateway, AccessControlEnumerable, PausableUntil {
    using RateLimitStorage for bytes32;
    using RateLimit for LimitData;

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 public constant ADD_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_WITHDRAWAL_REQUEST_ROLE");
    bytes32 public constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");

    bytes32 public constant EXIT_BALANCE_LIMIT_POSITION =
        keccak256("lido.TriggerableWithdrawalsGateway.exitBalanceLimitEth");

    uint256 internal constant GWEI_PER_ETH = 1 ether / 1 gwei;

    ILidoLocator public immutable LOCATOR;

    /// @dev Ensures the contract's ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    constructor(
        address admin,
        address lidoLocator,
        uint256 maxExitBalanceEth,
        uint256 balancePerFrameEth,
        uint256 frameDurationInSec
    ) {
        if (admin == address(0)) revert ZeroArgument("admin");
        if (lidoLocator == address(0)) revert ZeroArgument("lidoLocator");
        LOCATOR = ILidoLocator(lidoLocator);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setExitRequestLimit(maxExitBalanceEth, balancePerFrameEth, frameDurationInSec);
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
     *         A full withdrawal weighs FULL_WITHDRAWAL_WEIGHT_ETH against the exit balance limit,
     *         a partial withdrawal weighs its amount rounded up to whole ETH.
     * @param intents Withdrawal intents: `amount == 0` is a full withdrawal, `amount > 0` is a partial one (gwei)
     * @param refundRecipient Receiver of the unused fee; `address(0)` refunds to `msg.sender`
     */
    function triggerWithdrawals(
        WithdrawalIntent[] calldata intents,
        address refundRecipient
    ) external payable onlyRole(ADD_WITHDRAWAL_REQUEST_ROLE) preservesEthBalance whenResumed {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        uint256 requestsCount = intents.length;
        if (requestsCount == 0) revert ZeroArgument("intents");

        bytes[] memory pubkeys = new bytes[](requestsCount);
        uint64[] memory amounts = new uint64[](requestsCount);
        uint256 totalWeightEth = 0;

        for (uint256 i = 0; i < requestsCount; ++i) {
            uint64 amount = intents[i].amount;
            if (amount > MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI) revert WithdrawalAmountTooLarge(i, amount);

            pubkeys[i] = intents[i].pubkey;
            amounts[i] = amount;
            totalWeightEth += amount == 0 ? FULL_WITHDRAWAL_WEIGHT_ETH : (amount + GWEI_PER_ETH - 1) / GWEI_PER_ETH;
        }

        _consumeExitRequestLimit(totalWeightEth);

        IWithdrawalVault withdrawalVault = IWithdrawalVault(LOCATOR.withdrawalVault());
        uint256 totalFee = requestsCount * withdrawalVault.getWithdrawalRequestFee();
        uint256 refund = _checkFee(totalFee);

        withdrawalVault.addWithdrawalRequests{value: totalFee}(pubkeys, amounts);

        emit WithdrawalsTriggered(msg.sender, requestsCount, totalWeightEth);

        _refundFee(refund, refundRecipient);
    }

    /**
     * @notice Sets the exit balance limit
     * @param maxExitBalanceEth The maximum exit balance limit in ETH, at least FULL_WITHDRAWAL_WEIGHT_ETH
     * @param balancePerFrameEth The exit balance in ETH that is restored per frame
     * @param frameDurationInSec The duration of each frame, in seconds, after which `balancePerFrameEth` is restored
     */
    function setExitRequestLimit(
        uint256 maxExitBalanceEth,
        uint256 balancePerFrameEth,
        uint256 frameDurationInSec
    ) external onlyRole(TW_EXIT_LIMIT_MANAGER_ROLE) {
        _setExitRequestLimit(maxExitBalanceEth, balancePerFrameEth, frameDurationInSec);
    }

    /**
     * @notice Returns information about the exit balance limit
     * @return maxExitBalanceEth Maximum exit balance limit in ETH
     * @return balancePerFrameEth The exit balance in ETH that is restored per frame
     * @return frameDurationInSec The duration of each frame, in seconds, after which `balancePerFrameEth` is restored
     * @return prevExitBalanceEth Exit balance limit in ETH left after previous requests
     * @return currentExitBalanceEth Current exit balance limit in ETH
     */
    function getExitRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxExitBalanceEth,
            uint256 balancePerFrameEth,
            uint256 frameDurationInSec,
            uint256 prevExitBalanceEth,
            uint256 currentExitBalanceEth
        )
    {
        LimitData memory limitData = EXIT_BALANCE_LIMIT_POSITION.getStorageLimit();
        maxExitBalanceEth = limitData.maxLimit;
        balancePerFrameEth = limitData.itemsPerFrame;
        frameDurationInSec = limitData.frameDurationInSec;
        prevExitBalanceEth = limitData.prevLimit;
        currentExitBalanceEth = limitData.calculateCurrentLimit(_getTimestamp());
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

    function _setExitRequestLimit(
        uint256 maxExitBalanceEth,
        uint256 balancePerFrameEth,
        uint256 frameDurationInSec
    ) internal {
        // A lower limit or no restoration could leave a full withdrawal unable to ever fit
        if (maxExitBalanceEth < FULL_WITHDRAWAL_WEIGHT_ETH) revert TooSmallMaxExitBalance(maxExitBalanceEth);
        if (balancePerFrameEth == 0) revert ZeroArgument("balancePerFrameEth");

        uint256 timestamp = _getTimestamp();
        LimitData memory limitData = EXIT_BALANCE_LIMIT_POSITION.getStorageLimit();

        // `setLimits` restarts the frame, so materialize the balance restored so far to keep it
        if (limitData.isLimitSet()) {
            limitData = limitData.updatePrevLimit(limitData.calculateCurrentLimit(timestamp), timestamp);
        }

        EXIT_BALANCE_LIMIT_POSITION.setStorageLimit(
            limitData.setLimits(maxExitBalanceEth, balancePerFrameEth, frameDurationInSec, timestamp)
        );

        emit ExitBalanceLimitSet(maxExitBalanceEth, balancePerFrameEth, frameDurationInSec);
    }

    function _consumeExitRequestLimit(uint256 balanceEth) internal {
        LimitData memory limitData = EXIT_BALANCE_LIMIT_POSITION.getStorageLimit();
        uint256 timestamp = _getTimestamp();
        uint256 limitEth = limitData.calculateCurrentLimit(timestamp);

        if (balanceEth > limitEth) {
            revert ExitRequestsLimitExceeded(balanceEth, limitEth);
        }

        EXIT_BALANCE_LIMIT_POSITION.setStorageLimit(limitData.updatePrevLimit(limitEth - balanceEth, timestamp));
    }

    /**
     * @notice Emitted when withdrawal requests are submitted
     * @param caller Address that submitted the requests
     * @param requestsCount Number of submitted requests
     * @param weightEth Exit balance limit consumed by the requests, in ETH
     */
    event WithdrawalsTriggered(address indexed caller, uint256 requestsCount, uint256 weightEth);

    /**
     * @notice Emitted when the exit balance limit is set
     * @param maxExitBalanceEth The maximum exit balance limit in ETH
     * @param balancePerFrameEth The exit balance in ETH that is restored per frame
     * @param frameDurationInSec The duration of each frame, in seconds
     */
    event ExitBalanceLimitSet(uint256 maxExitBalanceEth, uint256 balancePerFrameEth, uint256 frameDurationInSec);

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
     * @notice Thrown when the remaining exit balance limit is not enough to cover the requests
     * @param requestedBalanceEth Weight of the requests in ETH
     * @param remainingBalanceEth Remaining exit balance limit in ETH
     */
    error ExitRequestsLimitExceeded(uint256 requestedBalanceEth, uint256 remainingBalanceEth);

    /**
     * @notice Thrown when a partial withdrawal amount exceeds MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI
     * @param index Index of the invalid intent in the passed array
     * @param amount Requested amount in gwei
     */
    error WithdrawalAmountTooLarge(uint256 index, uint256 amount);

    /**
     * @notice Thrown when the max exit balance limit is below FULL_WITHDRAWAL_WEIGHT_ETH
     * @param maxExitBalanceEth Passed max exit balance limit in ETH
     */
    error TooSmallMaxExitBalance(uint256 maxExitBalanceEth);
}
