// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {
    AccessControlEnumerableUpgradeable
} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ITriggerableWithdrawalsBus} from "contracts/common/interfaces/ITriggerableWithdrawalsBus.sol";
import {ITriggerableWithdrawalsGateway} from "contracts/common/interfaces/ITriggerableWithdrawalsGateway.sol";
import {WithdrawalIntent, MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI} from "contracts/common/interfaces/WithdrawalIntent.sol";

/**
 * @title TriggerableWithdrawalsBus
 * @author Lido
 * @notice FIFO queue of withdrawal intents (partial and full) that decouples the Oracle report from the
 *         EIP-7002 fee payment.
 *
 * The workflow:
 * 1. The TriggerableWithdrawalsOracle appends decoded report records to the tail of the queue (ADD_WITHDRAWAL_INTENTS_ROLE)
 * 2. Anyone pops intents from the head of the queue in order, paying the EIP-7002 fee;
 *    the bus forwards them to the TriggerableWithdrawalsGateway resolved via LidoLocator
 */
contract TriggerableWithdrawalsBus is ITriggerableWithdrawalsBus, AccessControlEnumerableUpgradeable {
    /// @notice role that allows to append withdrawal intents to the queue
    bytes32 public constant ADD_WITHDRAWAL_INTENTS_ROLE = keccak256("ADD_WITHDRAWAL_INTENTS_ROLE");

    uint256 internal constant PUBKEY_LENGTH = 48;

    /// @dev Queued intent packed into two slots:
    ///      `pubkeyHead` holds pubkey[0:32];
    ///      `pubkeyTailAndAmount` holds pubkey[32:48] in the high 16 bytes and the amount (uint64) in the low 8 bytes.
    struct PackedIntent {
        bytes32 pubkeyHead;
        bytes32 pubkeyTailAndAmount;
    }

    /// @custom:storage-location erc7201:lido.TriggerableWithdrawalsBus.storage
    struct Storage {
        uint128 head; // queue index of the next intent to process
        uint128 tail; // queue index the next added intent is stored at
        mapping(uint256 index => PackedIntent) intents;
    }

    /// @dev Storage slot: keccak256(abi.encode(uint256(keccak256("lido.TriggerableWithdrawalsBus.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_POSITION = 0x9e1225a4f3b25c5ccb4127158e802e544055b00f6ae9908793cdfb52b5dd5100;

    ILidoLocator public immutable LOCATOR;

    constructor(address lidoLocator) {
        if (lidoLocator == address(0)) revert ZeroArgument("lidoLocator");
        LOCATOR = ILidoLocator(lidoLocator);

        _disableInitializers();
    }

    /// @notice Initializes the contract.
    /// @param admin Address granted DEFAULT_ADMIN_ROLE.
    function initialize(address admin) external initializer {
        if (admin == address(0)) revert ZeroArgument("admin");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @notice Appends withdrawal intents to the tail of the queue in the passed order
     * @param intents Withdrawal intents: `amount == 0` is a full withdrawal, `amount > 0` is a partial one (gwei)
     */
    function addWithdrawalIntents(
        WithdrawalIntent[] calldata intents
    ) external onlyRole(ADD_WITHDRAWAL_INTENTS_ROLE) {
        uint256 count = intents.length;
        if (count == 0) revert ZeroArgument("intents");

        Storage storage $ = _storage();
        uint256 firstIndex = $.tail;

        for (uint256 i = 0; i < count; ++i) {
            bytes calldata pubkey = intents[i].pubkey;
            if (pubkey.length != PUBKEY_LENGTH) revert InvalidPubkeyLength(i, pubkey.length);

            uint64 amount = intents[i].amount;
            if (amount > MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI) revert WithdrawalAmountTooLarge(i, amount);

            $.intents[firstIndex + i] = PackedIntent({
                pubkeyHead: bytes32(pubkey[:32]),
                pubkeyTailAndAmount: bytes32(bytes16(pubkey[32:])) | bytes32(uint256(amount))
            });
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        $.tail = uint128(firstIndex + count);

        emit WithdrawalIntentsAdded(firstIndex, count);
    }

    /**
     * @notice Pops up to `count` intents from the head of the queue and executes them as withdrawal requests
     *         through the TriggerableWithdrawalsGateway, forwarding `msg.value` as the EIP-7002 fee
     * @param count Maximum number of intents to process
     * @param refundRecipient Receiver of the unused fee; `address(0)` refunds to `msg.sender`
     * @return processedCount Number of intents processed, less than `count` if the queue holds fewer intents
     * @dev If the gateway reverts (e.g. the batch exceeds its remaining limit), the queue is left unchanged
     */
    function processWithdrawalIntents(
        uint256 count,
        address refundRecipient
    ) external payable returns (uint256 processedCount) {
        if (count == 0) revert ZeroArgument("count");

        Storage storage $ = _storage();
        uint256 head = $.head;
        uint256 queued = $.tail - head;
        if (queued == 0) revert NoWithdrawalIntents();

        processedCount = count < queued ? count : queued;

        WithdrawalIntent[] memory intents = new WithdrawalIntent[](processedCount);
        for (uint256 i = 0; i < processedCount; ++i) {
            uint256 index = head + i;
            intents[i] = _unpack($.intents[index]);
            delete $.intents[index];
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        $.head = uint128(head + processedCount);

        emit WithdrawalIntentsProcessed(head, processedCount);

        // The gateway refunds to its caller when no recipient is set, and this contract cannot receive ETH
        if (refundRecipient == address(0)) {
            refundRecipient = msg.sender;
        }

        ITriggerableWithdrawalsGateway(LOCATOR.triggerableWithdrawalsGateway()).triggerWithdrawals{value: msg.value}(
            intents,
            refundRecipient
        );
    }

    // ==============
    //  View methods
    // ==============

    /**
     * @notice Returns the number of intents waiting in the queue
     */
    function unprocessedIntentsCount() external view returns (uint256) {
        Storage storage $ = _storage();
        return $.tail - $.head;
    }

    /**
     * @notice Returns up to `limit` queued intents starting at `offset` in execution order
     * @param offset Position in the queue, `0` is the next intent to be processed
     * @param limit Maximum number of intents to return
     * @return intents Queued intents, empty if `offset` is beyond the end of the queue
     */
    function getWithdrawalIntents(
        uint256 offset,
        uint256 limit
    ) external view returns (WithdrawalIntent[] memory intents) {
        Storage storage $ = _storage();
        uint256 queued = $.tail - $.head;
        if (offset >= queued) return intents;

        uint256 count = queued - offset;
        if (count > limit) count = limit;

        uint256 start = $.head + offset;
        intents = new WithdrawalIntent[](count);
        for (uint256 i = 0; i < count; ++i) {
            intents[i] = _unpack($.intents[start + i]);
        }
    }

    // ==================
    //  Internal methods
    // ==================

    function _unpack(PackedIntent storage packed) internal view returns (WithdrawalIntent memory) {
        bytes32 pubkeyTailAndAmount = packed.pubkeyTailAndAmount;
        // forge-lint: disable-start(unsafe-typecast)
        return
            WithdrawalIntent({
                amount: uint64(uint256(pubkeyTailAndAmount)),
                pubkey: abi.encodePacked(packed.pubkeyHead, bytes16(pubkeyTailAndAmount))
            });
        // forge-lint: disable-end(unsafe-typecast)
    }

    function _storage() internal pure returns (Storage storage $) {
        bytes32 position = STORAGE_POSITION;
        assembly ("memory-safe") {
            $.slot := position
        }
    }

    // ========
    //  Events
    // ========

    /**
     * @notice Emitted when intents are appended to the queue
     * @param firstIndex Queue index of the first added intent
     * @param count Number of added intents
     */
    event WithdrawalIntentsAdded(uint256 firstIndex, uint256 count);

    /**
     * @notice Emitted when intents are popped from the queue and sent to the gateway
     * @param firstIndex Queue index of the first processed intent
     * @param count Number of processed intents
     */
    event WithdrawalIntentsProcessed(uint256 firstIndex, uint256 count);

    // ========
    //  Errors
    // ========

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when a pubkey length is not 48 bytes
     * @param index Index of the invalid intent in the passed array
     * @param length Actual pubkey length in bytes
     */
    error InvalidPubkeyLength(uint256 index, uint256 length);

    /**
     * @notice Thrown when a partial withdrawal amount exceeds MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI
     * @param index Index of the invalid intent in the passed array
     * @param amount Requested amount in gwei
     */
    error WithdrawalAmountTooLarge(uint256 index, uint256 amount);

    /**
     * @notice Thrown when there are no intents in the queue to process
     */
    error NoWithdrawalIntents();
}
