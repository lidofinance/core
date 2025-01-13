// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { AccessControlEnumerable } from "../utils/access/AccessControlEnumerable.sol";
import { UnstructuredStorage } from "../lib/UnstructuredStorage.sol";
import { IWithdrawalVault } from "./IWithdrawalVault.sol";

contract ValidatorsExitBus is AccessControlEnumerable {
    using UnstructuredStorage for bytes32;

    /// @dev Errors
    // error DuplicateExitRequest();
    error KeyWasNotUnpacked(uint256 keyIndex, uint256 lastUnpackedKeyIndex);
    error ZeroAddress();

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

     /// @dev Storage slot: address withdrawalVaultContract
    bytes32 internal constant WITHDRAWAL_VAULT_CONTRACT_POSITION =
        keccak256("lido.ValidatorsExitBus.withdrawalVaultContract");

    // ILidoLocator internal immutable LOCATOR;

    // TODO: read WV via locator
    function _initialize_v2(address withdrawalVaultAddr) internal {
      _setWithdrawalVault(withdrawalVaultAddr);
    }

    function _setWithdrawalVault(address addr) internal {
        if (addr == address(0)) revert ZeroAddress();

        WITHDRAWAL_VAULT_CONTRACT_POSITION.setStorageAddress(addr);
    }

    function triggerExitHashVerify(ExitRequestData calldata exitRequestData, uint256[] calldata keyIndexes) external payable {
        bytes32 dataHash = keccak256(abi.encode(exitRequestData));
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[dataHash];

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

        address withdrawalVaultAddr = WITHDRAWAL_VAULT_CONTRACT_POSITION.getStorageAddress();
        IWithdrawalVault(withdrawalVaultAddr).addFullWithdrawalRequests(pubkeys);
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