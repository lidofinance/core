// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {ExitRequestLimitData, ExitLimitUtilsStorage, ExitLimitUtils} from "./lib/ExitLimitUtils.sol";

interface IWithdrawalVault {
    function addWithdrawalRequests(bytes calldata pubkeys, uint64[] calldata amounts) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}

interface IStakingRouter {
    function onValidatorExitTriggered(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bytes calldata _publicKey,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external;
}

/**
 * @title TriggerableWithdrawalsGateway
 * @notice TriggerableWithdrawalsGateway contract is one entrypoint for all triggerable withdrawal requests (TWRs) in protocol.
 * This contract is responsible for limiting TWRs, checking ADD_FULL_WITHDRAWAL_REQUEST_ROLE role before it gets to Withdrawal Vault.
 */
contract TriggerableWithdrawalsGateway is AccessControlEnumerable {
    using ExitLimitUtilsStorage for bytes32;
    using ExitLimitUtils for ExitRequestLimitData;

    /// @dev Errors
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
    error InsufficientWithdrawalFee(uint256 feeRequired, uint256 passedValue);
    /**
     * @notice Thrown when a withdrawal fee refund failed
     */
    error TriggerableWithdrawalFeeRefundFailed();
    /**
     * @notice Emitted when an entity with the ADD_FULL_WITHDRAWAL_REQUEST_ROLE requests to process a TWR (triggerable withdrawal request).
     * @param stakingModuleId Module id.
     * @param nodeOperatorId Operator id.
     * @param validatorPubkey Validator public key.
     * @param timestamp Block timestamp.
     */
    event TriggerableExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        bytes validatorPubkey,
        uint256 timestamp
    );
    /**
     * @notice Emitted when maximum exit request limit and the frame during which a portion of the limit can be restored set.
     * @param maxExitRequestsLimit The maximum number of exit requests. The period for which this value is valid can be calculated as: X = maxExitRequests / (exitsPerFrame * frameDuration)
     * @param exitsPerFrame The number of exits that can be restored per frame.
     * @param frameDuration The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     */
    event ExitRequestsLimitSet(uint256 maxExitRequestsLimit, uint256 exitsPerFrame, uint256 frameDuration);
    /**
     * @notice Thrown when remaining exit requests limit is not enough to cover sender requests
     * @param requestsCount Amount of requests that were sent for processing
     * @param remainingLimit Amount of requests that still can be processed at current day
     */
    error ExitRequestsLimit(uint256 requestsCount, uint256 remainingLimit);

    struct ValidatorData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        bytes pubkey;
    }

    bytes32 public constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
    bytes32 public constant TW_EXIT_REPORT_LIMIT_ROLE = keccak256("TW_EXIT_REPORT_LIMIT_ROLE");

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

    constructor(address admin, address lidoLocator) {
        if (admin == address(0)) revert AdminCannotBeZero();
        LOCATOR = ILidoLocator(lidoLocator);

        _setupRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @dev Submits Triggerable Withdrawal Requests to the Withdrawal Vault as full withdrawal requests
     *      for the specified validator public keys.
     *
     * @param triggerableExitsData An array of `ValidatorData` structs, each representing a validator
     * for which a withdrawal request will be submitted. Each entry includes:
     *   - `stakingModuleId`: ID of the staking module.
     *   - `nodeOperatorId`: ID of the node operator.
     *   - `pubkey`: Validator public key, 48 bytes length.
     * @param refundRecipient The address that will receive any excess ETH sent for fees.
     * @param exitType A parameter indicating the type of exit, passed to the Staking Module.
     *
     * Emits `TriggerableExitRequest` event for each validator in list.
     *
     * @notice Reverts if:
     *     - The caller does not have the `ADD_FULL_WITHDRAWAL_REQUEST_ROLE`
     *     - The total fee value sent is insufficient to cover all provided TW requests.
     *     - There is not enough limit quota left in the current frame to process all requests.
     */
    function triggerFullWithdrawals(
        ValidatorData[] calldata triggerableExitsData,
        address refundRecipient,
        uint8 exitType
    ) external payable onlyRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE) preservesEthBalance {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (refundRecipient == address(0)) {
            refundRecipient = msg.sender;
        }

        uint256 requestsCount = triggerableExitsData.length;

        ExitRequestLimitData memory twrLimitData = TWR_LIMIT_POSITION.getStorageExitRequestLimit();
        if (twrLimitData.isExitLimitSet()) {
            uint256 timestamp = _getTimestamp();
            uint256 limit = twrLimitData.calculateCurrentExitLimit(timestamp);

            if (limit < requestsCount) {
                revert ExitRequestsLimit(requestsCount, limit);
            }

            TWR_LIMIT_POSITION.setStorageExitRequestLimit(
                twrLimitData.updatePrevExitLimit(limit - requestsCount, timestamp)
            );
        }

        uint256 withdrawalFee = IWithdrawalVault(LOCATOR.withdrawalVault()).getWithdrawalRequestFee();
        _checkFee(requestsCount, withdrawalFee);

        bytes memory pubkeys = new bytes(requestsCount * PUBLIC_KEY_LENGTH);

        for (uint256 i = 0; i < requestsCount; ++i) {
            ValidatorData memory data = triggerableExitsData[i];
            _copyPubkey(data.pubkey, pubkeys, i);
            _notifyStakingModule(data.stakingModuleId, data.nodeOperatorId, data.pubkey, withdrawalFee, exitType);

            emit TriggerableExitRequest(data.stakingModuleId, data.nodeOperatorId, data.pubkey, _getTimestamp());
        }

        _addWithdrawalRequest(requestsCount, withdrawalFee, pubkeys, refundRecipient);
    }

    /**
     * @notice Sets the maximum exit request limit and the frame during which a portion of the limit can be restored.
     * @param maxExitRequestsLimit The maximum number of exit requests. The period for which this value is valid can be calculated as: X = maxExitRequests / (exitsPerFrame * frameDuration)
     * @param exitsPerFrame The number of exits that can be restored per frame.
     * @param frameDuration The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     */
    function setExitRequestLimit(
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDuration
    ) external onlyRole(TW_EXIT_REPORT_LIMIT_ROLE) {
        require(maxExitRequestsLimit >= exitsPerFrame, "TOO_LARGE_TW_EXIT_REQUEST_LIMIT");

        uint256 timestamp = _getTimestamp();

        TWR_LIMIT_POSITION.setStorageExitRequestLimit(
            TWR_LIMIT_POSITION.getStorageExitRequestLimit().setExitLimits(
                maxExitRequestsLimit,
                exitsPerFrame,
                frameDuration,
                timestamp
            )
        );

        emit ExitRequestsLimitSet(maxExitRequestsLimit, exitsPerFrame, frameDuration);
    }

    /**
     * @notice Returns information about current limits data
     * @return maxExitRequestsLimit Maximum exit requests limit
     * @return exitsPerFrame The number of exits that can be restored per frame.
     * @return frameDuration The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     * @return prevExitRequestsLimit Limit left after previous requests
     * @return currentExitRequestsLimit Current exit requests limit
     */
    function getExitRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxExitRequestsLimit,
            uint256 exitsPerFrame,
            uint256 frameDuration,
            uint256 prevExitRequestsLimit,
            uint256 currentExitRequestsLimit
        )
    {
        ExitRequestLimitData memory exitRequestLimitData = TWR_LIMIT_POSITION.getStorageExitRequestLimit();
        maxExitRequestsLimit = exitRequestLimitData.maxExitRequestsLimit;
        exitsPerFrame = exitRequestLimitData.exitsPerFrame;
        frameDuration = exitRequestLimitData.frameDuration;
        prevExitRequestsLimit = exitRequestLimitData.prevExitRequestsLimit;
        currentExitRequestsLimit = _getCurrentExitLimit();
    }

    /// Internal functions

    function _checkFee(uint256 requestsCount, uint256 withdrawalFee) internal {
        if (msg.value < requestsCount * withdrawalFee) {
            revert InsufficientWithdrawalFee(requestsCount * withdrawalFee, msg.value);
        }
    }

    function _copyPubkey(bytes memory pubkey, bytes memory pubkeys, uint256 index) internal pure {
        assembly {
            let pubkeyMemPtr := add(pubkey, 32)
            let pubkeysOffset := add(pubkeys, add(32, mul(PUBLIC_KEY_LENGTH, index)))
            mstore(pubkeysOffset, mload(pubkeyMemPtr))
            mstore(add(pubkeysOffset, 32), mload(add(pubkeyMemPtr, 32)))
        }
    }

    function _notifyStakingModule(
        uint256 stakingModuleId,
        uint256 nodeOperatorId,
        bytes memory pubkey,
        uint256 withdrawalRequestPaidFee,
        uint8 exitType
    ) internal {
        IStakingRouter(LOCATOR.stakingRouter()).onValidatorExitTriggered(
            stakingModuleId,
            nodeOperatorId,
            pubkey,
            withdrawalRequestPaidFee,
            exitType
        );
    }

    function _addWithdrawalRequest(
        uint256 requestsCount,
        uint256 withdrawalFee,
        bytes memory pubkeys,
        address refundRecipient
    ) internal {
        IWithdrawalVault(LOCATOR.withdrawalVault()).addWithdrawalRequests{value: requestsCount * withdrawalFee}(
            pubkeys,
            new uint64[](requestsCount)
        );

        _refundFee(requestsCount * withdrawalFee, refundRecipient);
    }

    function _refundFee(uint256 fee, address recipient) internal returns (uint256) {
        uint256 refund = msg.value - fee;

        if (refund > 0) {
            (bool success, ) = recipient.call{value: refund}("");

            if (!success) {
                revert TriggerableWithdrawalFeeRefundFailed();
            }
        }

        return refund;
    }

    function _getTimestamp() internal view virtual returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    function _getCurrentExitLimit() internal view returns (uint256) {
        ExitRequestLimitData memory twrLimitData = TWR_LIMIT_POSITION.getStorageExitRequestLimit();
        if (!twrLimitData.isExitLimitSet()) {
            return type(uint256).max;
        }

        return twrLimitData.calculateCurrentExitLimit(_getTimestamp());
    }
}
