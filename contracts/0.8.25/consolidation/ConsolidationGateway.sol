// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {LimitData, RateLimitStorage, RateLimit} from "contracts/common/lib/RateLimit.sol";
import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {CLProofVerifier} from "contracts/0.8.25/vaults/predeposit_guarantee/CLProofVerifier.sol";
import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";

interface IDepositSecurityModule {
    function isDepositsPaused() external view returns (bool);
}

interface ILido {
    function canDeposit() external view returns (bool);
}

interface IWithdrawalVault {
    function addConsolidationRequests(bytes[] calldata sourcePubkeys, bytes[] calldata targetPubkeys) external payable;

    function getConsolidationRequestFee() external view returns (uint256);
}

/**
 * @title ConsolidationGateway
 * @notice ConsolidationGateway contract is one entrypoint for all consolidation requests in protocol.
 * This contract is responsible for limiting consolidation requests, checking ADD_CONSOLIDATION_REQUEST_ROLE role before it gets to Withdrawal Vault.
 */
contract ConsolidationGateway is AccessControlEnumerable, PausableUntil, CLProofVerifier {
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
     * @notice Thrown when a consolidation fee is insufficient
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
     * @param remainingLimit Amount of requests that still can be processed at current frame
     */
    error ConsolidationRequestsLimitExceeded(uint256 requestsCount, uint256 remainingLimit);

    /**
     * @notice Thrown when a source group has zero elements
     * @param groupIndex Index of the empty group
     */
    error EmptyGroup(uint256 groupIndex);

    /**
     * @notice Thrown when DSM deposits are paused
     */
    error DSMDepositsPaused();

    /**
     * @notice Thrown when Lido deposits are paused (Lido stopped or bunker mode)
     */
    error LidoDepositsPaused();

    /**
     * @notice Emitted when limits configs are set.
     * @param maxConsolidationRequestsLimit The maximum number of consolidation requests.
     * @param consolidationsPerFrame The number of consolidations that can be restored per frame.
     * @param frameDurationInSec The duration of each frame, in seconds, after which `consolidationsPerFrame` consolidations can be restored.
     */
    event ConsolidationRequestsLimitSet(
        uint256 maxConsolidationRequestsLimit,
        uint256 consolidationsPerFrame,
        uint256 frameDurationInSec
    );

    /// @notice role that allows to pause the contract
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");

    /// @notice role that allows to resume the contract
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");

    bytes32 public constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 public constant EXIT_LIMIT_MANAGER_ROLE = keccak256("EXIT_LIMIT_MANAGER_ROLE");

    bytes32 public constant CONSOLIDATION_LIMIT_POSITION =
        keccak256("lido.ConsolidationGateway.maxConsolidationRequestLimit");

    uint256 internal constant COMPOUNDING_PREFIX = uint256(0x02) << 248;

    struct ConsolidationWitnessGroup {
        bytes[] sourcePubkeys;
        IPredepositGuarantee.ValidatorWitness targetWitness;
    }

    ILidoLocator internal immutable LOCATOR;

    /// @dev Ensures the contract's ETH balance is unchanged.
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
        uint256 frameDurationInSec,
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        uint64 _pivotSlot
    ) CLProofVerifier(_gIFirstValidatorPrev, _gIFirstValidatorCurr, _pivotSlot) {
        if (admin == address(0)) revert AdminCannotBeZero();
        if (lidoLocator == address(0)) revert ZeroArgument("lidoLocator");
        LOCATOR = ILidoLocator(lidoLocator);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setConsolidationRequestLimit(maxConsolidationRequestsLimit, consolidationsPerFrame, frameDurationInSec);
    }

    /**
     * @notice Resume the contract
     * @dev Reverts if contract is not paused
     * @dev Reverts if sender has no `RESUME_ROLE`
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pause the contract for a specified period
     * @param _duration pause duration in seconds (use `PAUSE_INFINITELY` for unlimited)
     * @dev Reverts if contract is already paused
     * @dev Reverts if sender has no `PAUSE_ROLE`
     * @dev Reverts if zero duration is passed
     */
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /**
     * @notice Pause the contract until a specified timestamp
     * @param _pauseUntilInclusive the last second to pause until inclusive
     * @dev Reverts if the timestamp is in the past
     * @dev Reverts if sender has no `PAUSE_ROLE`
     * @dev Reverts if contract is already paused
     */
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /**
     * @dev Submits grouped Consolidation Requests to the Withdrawal Vault.
     *      Each group represents multiple source validators consolidating into a single target.
     * @param groups An array of consolidation groups, where each group contains source public keys
     *        and a target validator witness with a CL proof of withdrawal credentials.
     * @param refundRecipient The address that will receive any excess ETH sent for fees.
     *
     * @notice Reverts if:
     *     - The caller does not have the `ADD_CONSOLIDATION_REQUEST_ROLE`
     *     - The total fee value sent is insufficient to cover all provided consolidation requests.
     *     - There is not enough limit quota left in the current frame to process all requests.
     */
    function addConsolidationRequests(
        ConsolidationWitnessGroup[] calldata groups,
        address refundRecipient
    ) external payable onlyRole(ADD_CONSOLIDATION_REQUEST_ROLE) preservesEthBalance whenResumed {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        uint256 groupsCount = groups.length;
        if (groupsCount == 0) revert ZeroArgument("groups");

        // Count total individual requests across all groups
        uint256 requestsCount = 0;
        for (uint256 i = 0; i < groupsCount; ++i) {
            uint256 groupSize = groups[i].sourcePubkeys.length;
            if (groupSize == 0) revert EmptyGroup(i);
            requestsCount += groupSize;
        }

        _checkConsolidationPreconditions();

        (IWithdrawalVault withdrawalVault, bytes32 withdrawalCredentials) = _getWithdrawalVaultData();

        for (uint256 i = 0; i < groupsCount; ++i) {
            _validatePubKeyWCProof(groups[i].targetWitness, withdrawalCredentials);
        }

        _consumeConsolidationRequestLimit(requestsCount);

        uint256 fee = withdrawalVault.getConsolidationRequestFee();
        uint256 totalFee = requestsCount * fee;
        uint256 refund = _checkFee(totalFee);

        // Expand grouped requests into flat pairs for WithdrawalVault
        (bytes[] memory sourcePubkeys, bytes[] memory targetPubkeys) = _prepareConsolidationPairs(
            groups,
            requestsCount
        );
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
    ) external onlyRole(EXIT_LIMIT_MANAGER_ROLE) {
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

    function _checkConsolidationPreconditions() internal view {
        // If DSM paused deposits, some validators may not belong to Lido
        // and can therefore have non-Lido withdrawal credentials.
        // To avoid accepting consolidations into such validators, new consolidation requests are blocked.
        // This acts as an additional safety check on top of validator proof verification.
        if (IDepositSecurityModule(LOCATOR.depositSecurityModule()).isDepositsPaused()) {
            revert DSMDepositsPaused();
        }

        // If Lido stopped or bunker mode is active, new consolidation requests must also be blocked.
        if (!ILido(LOCATOR.lido()).canDeposit()) {
            revert LidoDepositsPaused();
        }
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

        CONSOLIDATION_LIMIT_POSITION.setStorageLimit(limitData.updatePrevLimit(limit - requestsCount, _getTimestamp()));
    }

    /// Flattens grouped source pubkeys and repeats each group's target pubkey.
    function _prepareConsolidationPairs(
        ConsolidationWitnessGroup[] calldata groups,
        uint256 totalCount
    ) internal pure returns (bytes[] memory sourcePubkeys, bytes[] memory targetPubkeys) {
        sourcePubkeys = new bytes[](totalCount);
        targetPubkeys = new bytes[](totalCount);

        uint256 idx = 0;
        for (uint256 i = 0; i < groups.length; ++i) {
            bytes[] calldata group = groups[i].sourcePubkeys;
            bytes calldata target = groups[i].targetWitness.pubkey;
            for (uint256 j = 0; j < group.length; ++j) {
                sourcePubkeys[idx] = group[j];
                targetPubkeys[idx] = target;
                ++idx;
            }
        }
    }

    /// Returns the withdrawal vault and its 0x02 withdrawal credentials.
    function _getWithdrawalVaultData()
        internal
        view
        returns (IWithdrawalVault withdrawalVault, bytes32 withdrawalCredentials)
    {
        address vaultAddress = LOCATOR.withdrawalVault();
        withdrawalVault = IWithdrawalVault(vaultAddress);

        // withdrawalCredentials = 0x02 || 11 zero bytes || 20-byte vault address
        withdrawalCredentials = bytes32(COMPOUNDING_PREFIX | uint160(vaultAddress));
    }
}
