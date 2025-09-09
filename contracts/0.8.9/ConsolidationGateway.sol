// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {LimitData, RateLimitStorage, RateLimit} from "./lib/RateLimit.sol";
import {PausableUntil} from "./utils/PausableUntil.sol";

interface IWithdrawalVault {
    function addConsolidationRequests(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys
    ) external payable;

    function getConsolidationRequestFee() external view returns (uint256);
}

/**
 * @title ConsolidationGateway
 * @notice ConsolidationGateway contract is one entrypoint for all consolidation requests in protocol.
 * This contract is responsible for limiting consolidation requests, checking ADD_CONSOLIDATION_REQUEST_ROLE role before it gets to Withdrawal Vault.
 */
contract ConsolidationGateway is AccessControlEnumerable, PausableUntil {
    using RateLimitStorage for bytes32;
    using RateLimit for LimitData;

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when attempting to set the admin address to zero
     */
    error AdminCannotBeZero();

    /**
     * @notice Thrown when a consolidation fee insufficient
     * @param feeRequired Amount of fee required to cover consolidation request
     * @param passedValue Amount of fee sent to cover consolidation request
     */
    error InsufficientFee(uint256 feeRequired, uint256 passedValue);

    /**
     * @notice Thrown when a consolidation fee refund failed
     */
    error FeeRefundFailed();

    /**
     * @notice Thrown when remaining consolidation requests limit is not enough to cover sender requests
     * @param requestsCount Amount of requests that were sent for processing
     * @param remainingLimit Amount of requests that still can be processed at current day
     */
    error ConsolidationRequestsLimitExceeded(uint256 requestsCount, uint256 remainingLimit);

    
    error ArraysLengthMismatch(uint256 firstArrayLength, uint256 secondArrayLength);

    /**
     * @notice Emitted when limits configs are set.
     * @param maxConsolidationRequestsLimit The maximum number of consolidation requests.
     * @param consolidationsPerFrame The number of consolidations that can be restored per frame.
     * @param frameDurationInSec The duration of each frame, in seconds, after which `consolidationsPerFrame` consolidations can be restored.
     */
    event ConsolidationRequestsLimitSet(uint256 maxConsolidationRequestsLimit, uint256 consolidationsPerFrame, uint256 frameDurationInSec);

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 public constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 public constant CONSOLIDATION_LIMIT_MANAGER_ROLE = keccak256("CONSOLIDATION_LIMIT_MANAGER_ROLE");

    bytes32 public constant CONSOLIDATION_LIMIT_POSITION = keccak256("lido.ConsolidationGateway.maxConsolidationRequestLimit");

    uint256 public constant VERSION = 1;

    ILidoLocator internal immutable LOCATOR;

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    constructor(
        address admin,
        address lidoLocator,
        uint256 maxConsolidationRequestsLimit,
        uint256 consolidationsPerFrame,
        uint256 frameDurationInSec
    ) {
        if (admin == address(0)) revert AdminCannotBeZero();
        LOCATOR = ILidoLocator(lidoLocator);

        _setupRole(DEFAULT_ADMIN_ROLE, admin);
        _setConsolidationRequestLimit(maxConsolidationRequestsLimit, consolidationsPerFrame, frameDurationInSec);
    }

    /**
     * @dev Resumes the consolidation requests.
     * @notice Reverts if:
     *         - The contract is not paused.
     *         - The sender does not have the `RESUME_ROLE`.
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pauses the consolidation requests placement for a specified duration.
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
     * @notice Pauses the consolidation requests placement until a specified timestamp.
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
     * @dev Submits Consolidation Requests to the Withdrawal Vault
     *      for the specified validator public keys.
     * @param sourcePubkeys An array of 48-byte public keys corresponding to validators requesting the consolidation.
     * @param targetPubkeys An array of 48-byte public keys corresponding to validators receiving the consolidation.
     * @param refundRecipient The address that will receive any excess ETH sent for fees.
     *
     * @notice Reverts if:
     *     - The caller does not have the `ADD_CONSOLIDATION_REQUEST_ROLE`
     *     - The total fee value sent is insufficient to cover all provided consolidation requests.
     *     - There is not enough limit quota left in the current frame to process all requests.
     */
    function triggerConsolidation(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys,
        address refundRecipient
    ) external payable onlyRole(ADD_CONSOLIDATION_REQUEST_ROLE) preservesEthBalance whenResumed {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        uint256 requestsCount = sourcePubkeys.length;
        if (requestsCount == 0) revert ZeroArgument("sourcePubkeys");
        if (requestsCount != targetPubkeys.length)
            revert ArraysLengthMismatch(requestsCount, targetPubkeys.length);

        _consumeConsolidationRequestLimit(requestsCount);

        IWithdrawalVault withdrawalVault = IWithdrawalVault(LOCATOR.withdrawalVault());
        uint256 fee = withdrawalVault.getConsolidationRequestFee();
        uint256 totalFee = requestsCount * fee;
        uint256 refund = _checkFee(totalFee);

        withdrawalVault.addConsolidationRequests{value: totalFee}(sourcePubkeys, targetPubkeys);

        _refundFee(refund, refundRecipient);
    }

    /**
     * @notice Sets the maximum request limit and the frame during which a portion of the limit can be restored.
     * @param maxConsolidationRequestsLimit The maximum number of consolidation requests.
     * @param consolidationsPerFrame The number of consolidations that can be restored per frame.
     * @param frameDurationInSec The duration of each frame, in seconds, after which `consolidationsPerFrame` consolidations can be restored.
     */
    function setConsolidationRequestLimit(
        uint256 maxConsolidationRequestsLimit,
        uint256 consolidationsPerFrame,
        uint256 frameDurationInSec
    ) external onlyRole(CONSOLIDATION_LIMIT_MANAGER_ROLE) {
        _setConsolidationRequestLimit(maxConsolidationRequestsLimit, consolidationsPerFrame, frameDurationInSec);
    }

    /**
     * @notice Returns information about current limits data
     * @return maxConsolidationRequestsLimit Maximum consolidation requests limit
     * @return consolidationsPerFrame The number of consolidations that can be restored per frame.
     * @return frameDurationInSec The duration of each frame, in seconds, after which `consolidationsPerFrame` consolidations can be restored.
     * @return prevConsolidationRequestsLimit Limit left after previous requests
     * @return currentConsolidationRequestsLimit Current consolidation requests limit
     */
    function getConsolidationRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxConsolidationRequestsLimit,
            uint256 consolidationsPerFrame,
            uint256 frameDurationInSec,
            uint256 prevConsolidationRequestsLimit,
            uint256 currentConsolidationRequestsLimit
        )
    {
        LimitData memory limitData = CONSOLIDATION_LIMIT_POSITION.getStorageLimit();
        maxConsolidationRequestsLimit = limitData.maxLimit;
        consolidationsPerFrame = limitData.itemsPerFrame;
        frameDurationInSec = limitData.frameDurationInSec;
        prevConsolidationRequestsLimit = limitData.prevLimit;

        currentConsolidationRequestsLimit = limitData.isLimitSet()
            ? limitData.calculateCurrentLimit(_getTimestamp())
            : type(uint256).max;
    }

    /// Internal functions

    function _checkFee(uint256 fee) internal returns (uint256 refund) {
        if (msg.value < fee) {
            revert InsufficientFee(fee, msg.value);
        }
        unchecked {
            refund = msg.value - fee;
        }
    }

    function _refundFee(uint256 refund, address recipient) internal {
        if (refund > 0) {
            // If the refund recipient is not set, use the sender as the refund recipient
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

    function _setConsolidationRequestLimit(
        uint256 maxConsolidationRequestsLimit,
        uint256 consolidationsPerFrame,
        uint256 frameDurationInSec
    ) internal {
        uint256 timestamp = _getTimestamp();

        CONSOLIDATION_LIMIT_POSITION.setStorageLimit(
            CONSOLIDATION_LIMIT_POSITION.getStorageLimit().setLimits(
                maxConsolidationRequestsLimit,
                consolidationsPerFrame,
                frameDurationInSec,
                timestamp
            )
        );

        emit ConsolidationRequestsLimitSet(maxConsolidationRequestsLimit, consolidationsPerFrame, frameDurationInSec);
    }

    function _consumeConsolidationRequestLimit(uint256 requestsCount) internal {
        LimitData memory limitData = CONSOLIDATION_LIMIT_POSITION.getStorageLimit();
        if (!limitData.isLimitSet()) {
            return;
        }

        uint256 limit = limitData.calculateCurrentLimit(_getTimestamp());

        if (limit < requestsCount) {
            revert ConsolidationRequestsLimitExceeded(requestsCount, limit);
        }

        CONSOLIDATION_LIMIT_POSITION.setStorageLimit(
            limitData.updatePrevLimit(limit - requestsCount, _getTimestamp())
        );
    }
}
