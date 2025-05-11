// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";

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
 * @title TriggerableWithdrawalGateway
 * @notice TriggerableWithdrawalGateway contract is one entrypoint for all triggerable withdrawal requests (TWRs) in protocol.
 * This contract is responsible for limiting TWRs, checking ADD_FULL_WITHDRAWAL_REQUEST_ROLE role before it gets to Withdrawal Vault.
 */
contract TriggerableWithdrawalGateway is AccessControlEnumerable {
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
     * @notice Emitted when someone with ADD_FULL_WITHDRAWAL_REQUEST_ROLE role request to process TWR.
     * @param stakingModuleId Module id
     * @param nodeOperatorId Operator id
     * @param validatorPubkey Validator public key
     * @param timestamp Block timestamp
     */
    event TriggerableExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        bytes validatorPubkey,
        uint256 timestamp
    );

    struct ValidatorData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        bytes pubkey;
    }

    bytes32 public constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");

    /// Length in bytes of packed triggerable exit request
    uint256 internal constant PACKED_EXIT_REQUEST_LENGTH = 56;
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    ILidoLocator internal immutable LOCATOR;

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    constructor(address lidoLocator) {
        LOCATOR = ILidoLocator(lidoLocator);
    }

    function initialize(address admin) external {
        if (admin == address(0)) revert AdminCannotBeZero();
        _setupRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @dev Submits Triggerable Withdrawal Requests to the Withdrawal Vault as full withdrawal requests
     *      for the specified validator public keys.
     *
     * @param triggerableExitData A packed byte array containing one or more 56-byte items, each representing:
     *        MSB <-------------------------------------------------- LSB
     *        |  3 bytes          |  5 bytes         |    48 bytes     |
     *        |  stakingModuleId  |  nodeOperatorId  | validatorPubkey |
     *
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
        bytes calldata triggerableExitData,
        address refundRecipient,
        uint8 exitType
    ) external payable onlyRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE) preservesEthBalance {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (refundRecipient == address(0)) {
            refundRecipient = msg.sender;
        }

        _checkExitRequestData(triggerableExitData);

        uint256 requestsCount = triggerableExitData.length / PACKED_EXIT_REQUEST_LENGTH;
        uint256 withdrawalFee = IWithdrawalVault(LOCATOR.withdrawalVault()).getWithdrawalRequestFee();

        _checkFee(requestsCount, withdrawalFee);

        // TODO: this method will be covered with limits
        bytes memory pubkeys = new bytes(requestsCount * PUBLIC_KEY_LENGTH);

        for (uint256 i = 0; i < requestsCount; ++i) {
            ValidatorData memory data = _parseExitRequestData(triggerableExitData, i);

            _copyPubkey(data.pubkey, pubkeys, i);

            // TODO: is it correct to send here withdrawalFee?
            _notifyStakingModule(data.stakingModuleId, data.nodeOperatorId, data.pubkey, withdrawalFee, exitType);

            emit TriggerableExitRequest(data.stakingModuleId, data.nodeOperatorId, data.pubkey, block.timestamp);
        }

        _addWithdrawalRequest(requestsCount, withdrawalFee, pubkeys, refundRecipient);
    }

    /// Internal functions

    function _checkExitRequestData(bytes calldata triggerableExitData) internal pure {
        if (triggerableExitData.length % PACKED_EXIT_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }
    }

    function _checkFee(uint256 requestsCount, uint256 withdrawalFee) internal {
        if (msg.value < requestsCount * withdrawalFee) {
            revert InsufficientWithdrawalFee(requestsCount * withdrawalFee, msg.value);
        }
    }

    function _parseExitRequestData(
        bytes calldata request,
        uint256 requestNumber
    ) internal pure returns (ValidatorData memory data) {
        uint256 dataWithoutPubkey;
        uint256 offset;
        bytes calldata pubkey;

        assembly {
            offset := add(request.offset, mul(requestNumber, PACKED_EXIT_REQUEST_LENGTH))
            dataWithoutPubkey := shr(192, calldataload(offset))
            pubkey.length := 48
            // 8 bytes =  3 bytes (module id) + 5 bytes (operator id)
            pubkey.offset := add(offset, 8)
        }

        data.nodeOperatorId = uint40(dataWithoutPubkey);
        data.stakingModuleId = uint24(dataWithoutPubkey >> 40);
        data.pubkey = pubkey;
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
}
