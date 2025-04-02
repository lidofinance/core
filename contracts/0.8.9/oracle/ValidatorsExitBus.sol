// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { AccessControlEnumerable } from "../utils/access/AccessControlEnumerable.sol";
import { UnstructuredStorage } from "../lib/UnstructuredStorage.sol";
import { ILidoLocator } from "../../common/interfaces/ILidoLocator.sol";
import { Versioned } from "../utils/Versioned.sol";
import { ReportExitLimitUtils, ReportExitLimitUtilsStorage, ExitRequestLimitData } from "../lib/ReportExitLimitUtils.sol";

interface IWithdrawalVault {
    function addFullWithdrawalRequests(bytes calldata pubkeys) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}

abstract contract ValidatorsExitBus is AccessControlEnumerable, Versioned {
    using UnstructuredStorage for bytes32;
    using ReportExitLimitUtilsStorage for bytes32;
    using ReportExitLimitUtils for ExitRequestLimitData;

    /// @dev Errors
    error KeyWasNotDelivered(uint256 keyIndex, uint256 lastDeliveredKeyIndex);
    error ZeroAddress();
    error InsufficientPayment(uint256 withdrawalFeePerRequest, uint256 requestCount, uint256 msgValue);
    error TriggerableWithdrawalRefundFailed();
    error ExitHashWasNotSubmitted();
    error KeyIndexOutOfRange(uint256 keyIndex, uint256 totalItemsCount);
    error UnsupportedRequestsDataFormat(uint256 format);
    error InvalidRequestsDataLength();
    error InvalidRequestsData();
    error ActorOutOfReportLimit();
    error RequestsAlreadyDelivered();
    error ExitRequestsLimit();

    /// @dev Events
    event MadeRefund(
        address sender,
        uint256 refundValue
    );

    event StoredExitRequestHash(
        bytes32 exitRequestHash
    );

    event ValidatorExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        uint256 indexed validatorIndex,
        bytes validatorPubkey,
        uint256 timestamp
    );

    event ExitRequestsLimitSet(
        uint256 _maxExitRequestsLimit,
        uint256 _exitRequestsLimitIncreasePerBlock
    );


    struct DeliveryHistory {
      /// @dev Key index in exit request array
      uint256 lastDeliveredKeyIndex;
      /// @dev Block timestamp
      uint256 timestamp;
    }
    struct RequestStatus {
      // Total items count in report (by default type(uint32).max, update on first report delivery)
      uint256 totalItemsCount;
      // Total processed items in report (by default 0)
      uint256 deliveredItemsCount;
      // Vebo contract version at the time of hash submittion
      uint256 contractVersion;

      DeliveryHistory[] deliverHistory;
    }

    struct ExitRequestData {
      bytes data;
      uint256 dataFormat;
      // TODO: maybe add requestCount for early exit and make it more safe
    }

    struct ValidatorExitData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        uint256 validatorIndex;
        bytes validatorPubkey;
    }

    bytes32 public constant SUBMIT_REPORT_HASH_ROLE = keccak256("SUBMIT_REPORT_HASH_ROLE");
    bytes32 public constant DIRECT_EXIT_HASH_ROLE = keccak256("DIRECT_EXIT_HASH_ROLE");
    bytes32 public constant EXIT_REPORT_LIMIT_ROLE = keccak256("EXIT_REPORT_LIMIT_ROLE");
    bytes32 public constant EXIT_REQUEST_LIMIT_POSITION = keccak256("lido.ValidatorsExitBus.maxExitRequestsLimit");

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    ILidoLocator internal immutable LOCATOR;


    /// @notice The list format of the validator exit requests data. Used when all
    /// requests fit into a single transaction.
    ///
    /// Each validator exit request is described by the following 64-byte array:
    ///
    /// MSB <------------------------------------------------------- LSB
    /// |  3 bytes   |  5 bytes   |     8 bytes      |    48 bytes     |
    /// |  moduleId  |  nodeOpId  |  validatorIndex  | validatorPubkey |
    ///
    /// All requests are tightly packed into a byte array where requests follow
    /// one another without any separator or padding, and passed to the `data`
    /// field of the report structure.
    ///
    /// Requests must be sorted in the ascending order by the following compound
    /// key: (moduleId, nodeOpId, validatorIndex).
    ///
    uint256 public constant DATA_FORMAT_LIST = 1;

    /// Hash constant for mapping exit requests storage
    bytes32 internal constant EXIT_REQUESTS_HASHES_POSITION =
        keccak256("lido.ValidatorsExitBus.reportHashes");

    constructor(address lidoLocator) {
        LOCATOR = ILidoLocator(lidoLocator);
    }

    function submitReportHash(bytes32 exitReportHash) external onlyRole(SUBMIT_REPORT_HASH_ROLE) {
      uint256 contractVersion = getContractVersion();
      _storeExitRequestHash(exitReportHash,  type(uint256).max, 0, contractVersion, DeliveryHistory(0,0));
    }

    function emitExitEvents(ExitRequestData calldata request, uint256 contractVersion) external{
        bytes calldata data = request.data;
        _checkContractVersion(contractVersion);

        RequestStatus storage requestStatus = _storageExitRequestsHashes()[keccak256(abi.encode(data, request.dataFormat))];

        if (requestStatus.contractVersion == 0) {
          revert ExitHashWasNotSubmitted();
        }

        if (request.dataFormat != DATA_FORMAT_LIST) {
            revert UnsupportedRequestsDataFormat(request.dataFormat);
        }

        if (request.data.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }

        // TODO: hash requestsCount too

        if (requestStatus.totalItemsCount == type(uint256).max ) {
          requestStatus.totalItemsCount = request.data.length / PACKED_REQUEST_LENGTH;
        }

        uint256 deliveredItemsCount = requestStatus.deliveredItemsCount;
        uint256 restToDeliver = requestStatus.totalItemsCount - deliveredItemsCount;

        if (restToDeliver == 0 ) {
          revert RequestsAlreadyDelivered();
        }

        ExitRequestLimitData memory exitRequestLimitData = EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();

        uint256 requestsToDeliver;

        // check if limit set
        if (exitRequestLimitData.isExitReportLimitSet()) {
          uint256 limit = exitRequestLimitData.calculateCurrentExitRequestLimit();
          if (limit == 0) {
            revert ExitRequestsLimit();
          }

          requestsToDeliver = restToDeliver <= limit ? restToDeliver : limit;

          EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(exitRequestLimitData.updatePrevExitRequestsLimit(limit - requestsToDeliver));
        } else {
           // TODO: do we need to store prev exit limit here
           requestsToDeliver = restToDeliver;
        }

        uint256 offset;
        uint256 offsetPastEnd;

        assembly {
            offset := add(data.offset, mul(deliveredItemsCount, PACKED_REQUEST_LENGTH))
            offsetPastEnd := add(offset, mul(requestsToDeliver, PACKED_REQUEST_LENGTH))
        }

        bytes calldata pubkey;

        assembly {
            pubkey.length := 48
        }

        uint256 timestamp = block.timestamp;
        uint256 lastDeliveredKeyIndex = deliveredItemsCount;

        while (offset < offsetPastEnd) {
            uint256 dataWithoutPubkey;
            assembly {
                // 16 most significant bytes are taken by module id, node op id, and val index
                dataWithoutPubkey := shr(128, calldataload(offset))
                // the next 48 bytes are taken by the pubkey
                pubkey.offset := add(offset, 16)
                // totalling to 64 bytes
                offset := add(offset, 64)
            }

            uint64 valIndex = uint64(dataWithoutPubkey);
            uint256 nodeOpId = uint40(dataWithoutPubkey >> 64);
            uint256 moduleId = uint24(dataWithoutPubkey >> (64 + 40));

            if (moduleId == 0) {
                // emit ValidatorExitRequest(moduleId, nodeOpId, valIndex, pubkey, timestamp);
                revert InvalidRequestsData();
            }

            requestStatus.deliverHistory.push(DeliveryHistory(lastDeliveredKeyIndex, timestamp));
            lastDeliveredKeyIndex = lastDeliveredKeyIndex + 1;

            emit ValidatorExitRequest(moduleId, nodeOpId, valIndex, pubkey, timestamp);
        }

        requestStatus.deliveredItemsCount = deliveredItemsCount + requestsToDeliver;
    }

    /// @notice Triggers exits on the EL via the Withdrawal Vault contract after
    /// @dev This function verifies that the hash of the provided exit request data exists in storage
    // and ensures that the events for the requests specified in the `keyIndexes` array have already been delivered.
    function triggerExits(ExitRequestData calldata request, uint256[] calldata keyIndexes) external payable {
        uint256 prevBalance = address(this).balance - msg.value;
        bytes calldata data = request.data;
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[keccak256(abi.encode(data, request.dataFormat))];

        if (requestStatus.contractVersion == 0) {
          revert ExitHashWasNotSubmitted();
        }

        address locatorAddr = address(LOCATOR);
        address withdrawalVaultAddr = ILidoLocator(locatorAddr).withdrawalVault();
        uint256 withdrawalFee = IWithdrawalVault(withdrawalVaultAddr).getWithdrawalRequestFee();

        if (msg.value < keyIndexes.length * withdrawalFee ) {
           revert InsufficientPayment(withdrawalFee, keyIndexes.length, msg.value);
        }

        uint256 lastDeliveredKeyIndex = requestStatus.deliveredItemsCount - 1;

        bytes memory pubkeys = new bytes(keyIndexes.length * PUBLIC_KEY_LENGTH);

        // TODO: create library for reading DATA
        for (uint256 i = 0; i < keyIndexes.length; i++) {
            if (keyIndexes[i] >= requestStatus.totalItemsCount) {
               revert KeyIndexOutOfRange(keyIndexes[i], requestStatus.totalItemsCount);
            }

            if (keyIndexes[i] > lastDeliveredKeyIndex) {
                revert KeyWasNotDelivered(keyIndexes[i], lastDeliveredKeyIndex);
            }

            ///
            /// |  3 bytes   |  5 bytes   |     8 bytes      |    48 bytes     |
            /// |  moduleId  |  nodeOpId  |  validatorIndex  | validatorPubkey |
            /// 16 bytes - part without pubkey
            uint256 requestPublicKeyOffset = keyIndexes[i] * PACKED_REQUEST_LENGTH + 16;
            uint256 destOffset = i * PUBLIC_KEY_LENGTH;

            assembly {
                let dest := add(pubkeys, add(32, destOffset))
                calldatacopy(
                    dest,
                    add(data.offset,  requestPublicKeyOffset),
                    PUBLIC_KEY_LENGTH
                )
            }
        }

        IWithdrawalVault(withdrawalVaultAddr).addFullWithdrawalRequests{value:  keyIndexes.length *  withdrawalFee}(pubkeys);

        uint256 refund = msg.value - keyIndexes.length *  withdrawalFee;

        if (refund > 0) {
          (bool success, ) = msg.sender.call{value: refund}("");

           if (!success) {
                revert TriggerableWithdrawalRefundFailed();
           }

           emit MadeRefund(msg.sender, refund);
        }

        assert(address(this).balance == prevBalance);
    }

    function triggerExitsDirectly(ValidatorExitData calldata validator) external payable onlyRole(DIRECT_EXIT_HASH_ROLE) {
        uint256 prevBalance = address(this).balance - msg.value;
        address locatorAddr = address(LOCATOR);
        address withdrawalVaultAddr = ILidoLocator(locatorAddr).withdrawalVault();
        uint256 withdrawalFee = IWithdrawalVault(withdrawalVaultAddr).getWithdrawalRequestFee();
        uint256 timestamp = block.timestamp;

        if (msg.value < withdrawalFee ) {
           revert InsufficientPayment(withdrawalFee, 1, msg.value);
        }

        //TODO: check limit
        ExitRequestLimitData memory exitRequestLimitData = EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();

                // check if limit set
        if (exitRequestLimitData.isExitReportLimitSet()) {
          uint256 limit = exitRequestLimitData.calculateCurrentExitRequestLimit();
          if (limit == 0) {
            revert ExitRequestsLimit();
          }

          EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(exitRequestLimitData.updatePrevExitRequestsLimit(limit - 1));
        }

        IWithdrawalVault(withdrawalVaultAddr).addFullWithdrawalRequests{value:  withdrawalFee}(validator.validatorPubkey);

        emit ValidatorExitRequest(validator.stakingModuleId, validator.nodeOperatorId, validator.validatorIndex, validator.validatorPubkey, timestamp);

        uint256 refund = msg.value - withdrawalFee;

        if (refund > 0) {
          (bool success, ) = msg.sender.call{value: refund}("");

           if (!success) {
                revert TriggerableWithdrawalRefundFailed();
           }

           emit MadeRefund(msg.sender, refund);
        }

        assert(address(this).balance == prevBalance);
    }

    function setExitReportLimit(uint256 _maxExitRequestsLimit, uint256 _exitRequestsLimitIncreasePerBlock) external onlyRole(EXIT_REPORT_LIMIT_ROLE) {
        EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit().setExitReportLimit(_maxExitRequestsLimit, _exitRequestsLimitIncreasePerBlock)
        );

        emit ExitRequestsLimitSet(_maxExitRequestsLimit, _exitRequestsLimitIncreasePerBlock);
    }

    function getDeliveryHistory(bytes32 exitReportHash) external view returns (DeliveryHistory[] memory) {
      mapping(bytes32 => RequestStatus) storage hashes = _storageExitRequestsHashes();
      RequestStatus storage request = hashes[exitReportHash];

      return request.deliverHistory;
    }

    function _storeExitRequestHash(
        bytes32 exitRequestHash,
        uint256 totalItemsCount,
        uint256 deliveredItemsCount,
        uint256 contractVersion,
        DeliveryHistory memory history
    ) internal {
        mapping(bytes32 => RequestStatus) storage hashes = _storageExitRequestsHashes();
        RequestStatus storage request = hashes[exitRequestHash];

        if (request.contractVersion != 0) {
          return;
        }

        request.totalItemsCount = totalItemsCount;
        request.deliveredItemsCount = deliveredItemsCount;
        request.contractVersion = contractVersion;
        if (history.timestamp != 0) {
            request.deliverHistory.push(history);
        }


        emit StoredExitRequestHash(exitRequestHash);
    }

    /// Storage helpers
    function _storageExitRequestsHashes() internal pure returns (
        mapping(bytes32 => RequestStatus) storage r
    ) {
        bytes32 position = EXIT_REQUESTS_HASHES_POSITION;
        assembly {
            r.slot := position
        }
    }
}