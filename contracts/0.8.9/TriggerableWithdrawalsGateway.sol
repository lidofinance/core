// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {ExitRequestLimitData, ExitLimitUtilsStorage, ExitLimitUtils} from "./lib/ExitLimitUtils.sol";
import {PausableUntil} from "./utils/PausableUntil.sol";

struct ValidatorData {
    uint256 stakingModuleId;
    uint256 nodeOperatorId;
    bytes pubkey;
}

interface IWithdrawalVault {
    function addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}

interface IStakingRouter {
    function onValidatorExitTriggered(
        ValidatorData[] calldata validatorData,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external;
}

/**
 * @title TriggerableWithdrawalsGateway
 * @notice TriggerableWithdrawalsGateway contract is one entrypoint for all triggerable withdrawal requests (TWRs) in protocol.
 * This contract is responsible for limiting TWRs, checking ADD_FULL_WITHDRAWAL_REQUEST_ROLE role before it gets to Withdrawal Vault.
 */
contract TriggerableWithdrawalsGateway is AccessControlEnumerable, PausableUntil {
    using ExitLimitUtilsStorage for bytes32;
    using ExitLimitUtils for ExitRequestLimitData;

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
     * @notice Thrown when exit request has wrong length
     */
    error InvalidRequestsDataLength();

    /**
     * @notice Thrown when a withdrawal fee insufficient
     * @param feeRequired Amount of fee required to cover withdrawal request
     * @param passedValue Amount of fee sent to cover withdrawal request
     */
    error InsufficientFee(uint256 feeRequired, uint256 passedValue);

    /**
     * @notice Thrown when a withdrawal fee refund failed
     */
    error FeeRefundFailed();

    /**
     * @notice Thrown when remaining exit requests limit is not enough to cover sender requests
     * @param requestsCount Amount of requests that were sent for processing
     * @param remainingLimit Amount of requests that still can be processed at current day
     */
    error ExitRequestsLimitExceeded(uint256 requestsCount, uint256 remainingLimit);

    /**
     * @notice Emitted when limits configs are set.
     * @param maxExitRequestsLimit The maximum number of exit requests.
     * @param exitsPerFrame The number of exits that can be restored per frame.
     * @param frameDurationInSec The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     */
    event ExitRequestsLimitSet(uint256 maxExitRequestsLimit, uint256 exitsPerFrame, uint256 frameDurationInSec);

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 public constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
    bytes32 public constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");

    bytes32 public constant TWR_LIMIT_POSITION = keccak256("lido.TriggerableWithdrawalsGateway.maxExitRequestLimit");

    /// Length in bytes of packed triggerable exit request
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

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
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) {
        if (admin == address(0)) revert AdminCannotBeZero();
        LOCATOR = ILidoLocator(lidoLocator);

        _setupRole(DEFAULT_ADMIN_ROLE, admin);
        _setExitRequestLimit(maxExitRequestsLimit, exitsPerFrame, frameDurationInSec);
    }

    /**
     * @dev Resumes the triggerable withdrawals requests.
     * @notice Reverts if:
     *         - The contract is not paused.
     *         - The sender does not have the `RESUME_ROLE`.
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pauses the triggerable withdrawals requests placement for a specified duration.
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
     * @notice Pauses the triggerable withdrawals requests placement until a specified timestamp.
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
     * @dev Submits Triggerable Withdrawal Requests to the Withdrawal Vault as full withdrawal requests
     *      for the specified validator public keys.
     *
     * @param validatorsData An array of `ValidatorData` structs, each representing a validator
     * for which a withdrawal request will be submitted. Each entry includes:
     *   - `stakingModuleId`: ID of the staking module.
     *   - `nodeOperatorId`: ID of the node operator.
     *   - `pubkey`: Validator public key, 48 bytes length.
     * @param refundRecipient The address that will receive any excess ETH sent for fees.
     * @param exitType A parameter indicating the type of exit, passed to the Staking Module.
     *
     * @notice Reverts if:
     *     - The caller does not have the `ADD_FULL_WITHDRAWAL_REQUEST_ROLE`
     *     - The total fee value sent is insufficient to cover all provided TW requests.
     *     - There is not enough limit quota left in the current frame to process all requests.
     */
    function triggerFullWithdrawals(
        ValidatorData[] calldata validatorsData,
        address refundRecipient,
        uint256 exitType
    ) external payable onlyRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE) preservesEthBalance whenResumed {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        uint256 requestsCount = validatorsData.length;
        if (requestsCount == 0) revert ZeroArgument("validatorsData");

        _consumeExitRequestLimit(requestsCount);

        IWithdrawalVault withdrawalVault = IWithdrawalVault(LOCATOR.withdrawalVault());
        uint256 fee = withdrawalVault.getWithdrawalRequestFee();
        uint256 totalFee = requestsCount * fee;
        uint256 refund = _checkFee(totalFee);

        bytes[] memory pubkeys = new bytes[](requestsCount);
        for (uint256 i = 0; i < requestsCount; ++i) {
            pubkeys[i] = validatorsData[i].pubkey;
        }

        withdrawalVault.addWithdrawalRequests{value: totalFee}(pubkeys, new uint64[](requestsCount));

        _notifyStakingModules(validatorsData, fee, exitType);
        _refundFee(refund, refundRecipient);
    }

    /**
     * @notice Sets the maximum exit request limit and the frame during which a portion of the limit can be restored.
     * @param maxExitRequestsLimit The maximum number of exit requests.
     * @param exitsPerFrame The number of exits that can be restored per frame.
     * @param frameDurationInSec The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     */
    function setExitRequestLimit(
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) external onlyRole(TW_EXIT_LIMIT_MANAGER_ROLE) {
        _setExitRequestLimit(maxExitRequestsLimit, exitsPerFrame, frameDurationInSec);
    }

    /**
     * @notice Returns information about current limits data
     * @return maxExitRequestsLimit Maximum exit requests limit
     * @return exitsPerFrame The number of exits that can be restored per frame.
     * @return frameDurationInSec The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     * @return prevExitRequestsLimit Limit left after previous requests
     * @return currentExitRequestsLimit Current exit requests limit
     */
    function getExitRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxExitRequestsLimit,
            uint256 exitsPerFrame,
            uint256 frameDurationInSec,
            uint256 prevExitRequestsLimit,
            uint256 currentExitRequestsLimit
        )
    {
        ExitRequestLimitData memory exitRequestLimitData = TWR_LIMIT_POSITION.getStorageExitRequestLimit();
        maxExitRequestsLimit = exitRequestLimitData.maxExitRequestsLimit;
        exitsPerFrame = exitRequestLimitData.exitsPerFrame;
        frameDurationInSec = exitRequestLimitData.frameDurationInSec;
        prevExitRequestsLimit = exitRequestLimitData.prevExitRequestsLimit;

        currentExitRequestsLimit = exitRequestLimitData.isExitLimitSet()
            ? exitRequestLimitData.calculateCurrentExitLimit(_getTimestamp())
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

    function _notifyStakingModules(
        ValidatorData[] calldata validatorsData,
        uint256 withdrawalRequestPaidFee,
        uint256 exitType
    ) internal {
        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());
        stakingRouter.onValidatorExitTriggered(validatorsData, withdrawalRequestPaidFee, exitType);
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

    function _setExitRequestLimit(
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) internal {
        uint256 timestamp = _getTimestamp();

        TWR_LIMIT_POSITION.setStorageExitRequestLimit(
            TWR_LIMIT_POSITION.getStorageExitRequestLimit().setExitLimits(
                maxExitRequestsLimit,
                exitsPerFrame,
                frameDurationInSec,
                timestamp
            )
        );

        emit ExitRequestsLimitSet(maxExitRequestsLimit, exitsPerFrame, frameDurationInSec);
    }

    function _consumeExitRequestLimit(uint256 requestsCount) internal {
        ExitRequestLimitData memory twrLimitData = TWR_LIMIT_POSITION.getStorageExitRequestLimit();
        if (!twrLimitData.isExitLimitSet()) {
            return;
        }

        uint256 limit = twrLimitData.calculateCurrentExitLimit(_getTimestamp());

        if (limit < requestsCount) {
            revert ExitRequestsLimitExceeded(requestsCount, limit);
        }

        TWR_LIMIT_POSITION.setStorageExitRequestLimit(
            twrLimitData.updatePrevExitLimit(limit - requestsCount, _getTimestamp())
        );
    }
}
