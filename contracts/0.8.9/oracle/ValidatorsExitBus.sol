// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { AccessControlEnumerable } from "../utils/access/AccessControlEnumerable.sol";
import { UnstructuredStorage } from "../lib/UnstructuredStorage.sol";
import { ILidoLocator } from "../../common/interfaces/ILidoLocator.sol";

interface IWithdrawalVault {
    function addFullWithdrawalRequests(bytes[] calldata pubkeys) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}


contract ValidatorsExitBus is AccessControlEnumerable {
    using UnstructuredStorage for bytes32;

    /// @dev Errors
    error KeyWasNotUnpacked(uint256 keyIndex, uint256 lastUnpackedKeyIndex);
    error ZeroAddress();
    error FeeNotEnough(uint256 minFeePerRequest, uint256 requestCount, uint256 msgValue);

    /// Part of report data
    struct ExitRequestData {
        /// @dev Total number of validator exit requests in this report. Must not be greater
        /// than limit checked in OracleReportSanityChecker.checkExitBusOracleReport.
        uint256 requestsCount;

        /// @dev Format of the validator exit requests data. Currently, only the
        /// DATA_FORMAT_LIST=1 is supported.
        uint256 dataFormat;

        /// @dev Validator exit requests data. Can differ based on the data format,
        /// see the constant defining a specific data format below for more info.
        bytes data;
    }

    // TODO: make type optimization
    struct DeliveryHistory {
      uint256 blockNumber;
      /// @dev Key index in exit request array
      uint256 lastDeliveredKeyIndex;
    }
    // TODO: make type optimization
    struct RequestStatus {
      // Total items count in report (by default type(uint32).max, update on first report unpack)
      uint256 totalItemsCount;
      // Total processed items in report (by default 0)
      uint256 deliveredItemsCount;
      // Vebo contract version at the time of hash submittion
      uint256 contractVersion;
      DeliveryHistory[] deliverHistory;
    }

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

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;

    /// Hash constant for mapping exit requests storage
    bytes32 internal constant EXIT_REQUESTS_HASHES_POSITION =
        keccak256("lido.ValidatorsExitBus.reportHashes");

    bytes32 private constant LOCATOR_CONTRACT_POSITION = keccak256("lido.ValidatorsExitBus.locatorContract");

    function _initialize_v2(address locatorAddr) internal {
      _setLocatorAddress(locatorAddr);
    }

    function _setLocatorAddress(address addr) internal {
        if (addr == address(0)) revert ZeroAddress();

        LOCATOR_CONTRACT_POSITION.setStorageAddress(addr);
    }

    function triggerExitHashVerify(ExitRequestData calldata exitRequestData, uint256[] calldata keyIndexes) external payable {
        bytes32 dataHash = keccak256(abi.encode(exitRequestData));
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[dataHash];

        address locatorAddr = LOCATOR_CONTRACT_POSITION.getStorageAddress();
        address withdrawalVaultAddr = ILidoLocator(locatorAddr).withdrawalVault();
        uint256 fee = IWithdrawalVault(withdrawalVaultAddr).getWithdrawalRequestFee();
        uint requestsFee = keyIndexes.length * fee;

        if (msg.value < requestsFee) {
           revert FeeNotEnough(fee, keyIndexes.length, msg.value);
        }

        uint256 refund = msg.value - requestsFee;

        uint256 lastDeliveredKeyIndex = requestStatus.deliveredItemsCount - 1;

        uint256 offset;
        bytes calldata data = exitRequestData.data;
        bytes[] memory pubkeys = new bytes[](keyIndexes.length);

        assembly {
            offset := data.offset
        }

        for (uint256 i = 0; i < keyIndexes.length; i++) {
            if (keyIndexes[i] > lastDeliveredKeyIndex) {
                revert KeyWasNotUnpacked(keyIndexes[i], lastDeliveredKeyIndex);
            }
            uint256 requestOffset = offset + keyIndexes[i] * 64;

            bytes calldata pubkey;

            assembly {
                pubkey.offset := add(requestOffset, 16)
                pubkey.length := 48
            }
             pubkeys[i] = pubkey;

        }

        IWithdrawalVault(withdrawalVaultAddr).addFullWithdrawalRequests(pubkeys);

        if (refund > 0) {
          (bool success, ) = msg.sender.call{value: refund}("");
          require(success, "Refund failed");
        }

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