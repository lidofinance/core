// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { AccessControlEnumerable } from "../utils/access/AccessControlEnumerable.sol";
import { UnstructuredStorage } from "../lib/UnstructuredStorage.sol";
import { ILidoLocator } from "../../common/interfaces/ILidoLocator.sol";

interface IWithdrawalVault {
    function addFullWithdrawalRequests(bytes calldata pubkeys) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}

contract ValidatorsExitBus is AccessControlEnumerable {
    using UnstructuredStorage for bytes32;

    /// @dev Errors
    error KeyWasNotDelivered(uint256 keyIndex, uint256 lastDeliveredKeyIndex);
    error ZeroAddress();
    error InsufficientPayment(uint256 withdrawalFeePerRequest, uint256 requestCount, uint256 msgValue);
    error TriggerableWithdrawalRefundFailed();
    error ExitHashWasNotSubmitted();
    error KeyIndexOutOfRange(uint256 keyIndex, uint256 totalItemsCount);

    /// @dev Events
    event MadeRefund(
        address sender,
        uint256 refundValue
    );
    event StoredExitRequestHash(
        bytes32 exitRequestHash
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
    }

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    /// Hash constant for mapping exit requests storage
    bytes32 internal constant EXIT_REQUESTS_HASHES_POSITION =
        keccak256("lido.ValidatorsExitBus.reportHashes");

    bytes32 internal constant LOCATOR_CONTRACT_POSITION = keccak256("lido.ValidatorsExitBus.locatorContract");

    function _setLocatorAddress(address addr) internal {
        if (addr == address(0)) revert ZeroAddress();

        LOCATOR_CONTRACT_POSITION.setStorageAddress(addr);
    }

    /// @notice Triggers exits on the EL via the Withdrawal Vault contract after
    /// @dev This function verifies that the hash of the provided exit request data exists in storage
    // and ensures that the events for the requests specified in the `keyIndexes` array have already been delivered.
    function triggerExits(ExitRequestData calldata request, uint256[] calldata keyIndexes) external payable {
        uint256 prevBalance = address(this).balance - msg.value;
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[keccak256(abi.encode(request.data, request.dataFormat))];
        bytes calldata data = request.data;

        if (requestStatus.contractVersion == 0) {
          revert ExitHashWasNotSubmitted();
        }

        address locatorAddr = LOCATOR_CONTRACT_POSITION.getStorageAddress();
        address withdrawalVaultAddr = ILidoLocator(locatorAddr).withdrawalVault();
        uint256 withdrawalFee = IWithdrawalVault(withdrawalVaultAddr).getWithdrawalRequestFee();

        if (msg.value < keyIndexes.length * withdrawalFee ) {
           revert InsufficientPayment(withdrawalFee, keyIndexes.length, msg.value);
        }

        uint256 lastDeliveredKeyIndex = requestStatus.deliveredItemsCount - 1;

        bytes memory pubkeys = new bytes(keyIndexes.length * PUBLIC_KEY_LENGTH);

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

    function _storeExitRequestHash(
        bytes32 exitRequestHash,
        uint256 totalItemsCount,
        uint256 deliveredItemsCount,
        uint256 contractVersion,
        uint256 lastDeliveredKeyIndex
    ) internal {
        if (deliveredItemsCount == 0) {
            return;
        }

        mapping(bytes32 => RequestStatus) storage hashes = _storageExitRequestsHashes();

        RequestStatus storage request = hashes[exitRequestHash];

        request.totalItemsCount = totalItemsCount;
        request.deliveredItemsCount = deliveredItemsCount;
        request.contractVersion = contractVersion;
        request.deliverHistory.push(DeliveryHistory({
            timestamp: block.timestamp,
            lastDeliveredKeyIndex: lastDeliveredKeyIndex
        }));

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
