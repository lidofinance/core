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
    error KeyWasNotUnpacked(uint256 keyIndex, uint256 lastUnpackedKeyIndex);
    error ZeroAddress();
    error FeeNotEnough(uint256 minFeePerRequest, uint256 requestCount, uint256 msgValue);
    error TriggerableWithdrawalRefundFailed();

    // TODO: make type optimization
    struct DeliveryHistory {
      uint256 blockNumber;
      /// @dev Key index in exit request array
      uint256 lastDeliveredKeyIndex;

      // TODO: timestamp
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

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    /// Hash constant for mapping exit requests storage
    bytes32 internal constant EXIT_REQUESTS_HASHES_POSITION =
        keccak256("lido.ValidatorsExitBus.reportHashes");

    bytes32 private constant LOCATOR_CONTRACT_POSITION = keccak256("lido.ValidatorsExitBus.locatorContract");

    constructor(address locatorAddr) {
      _setLocatorAddress(locatorAddr);
    }

    function _setLocatorAddress(address addr) internal {
        if (addr == address(0)) revert ZeroAddress();

        LOCATOR_CONTRACT_POSITION.setStorageAddress(addr);
    }

    function triggerExitHashVerify(bytes calldata data, uint256[] calldata keyIndexes) external payable {
        bytes32 dataHash = keccak256(abi.encode(data));
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[dataHash];

        address locatorAddr = LOCATOR_CONTRACT_POSITION.getStorageAddress();
        address withdrawalVaultAddr = ILidoLocator(locatorAddr).withdrawalVault();
        uint256 minFee = IWithdrawalVault(withdrawalVaultAddr).getWithdrawalRequestFee();
        uint256 requestsFee = keyIndexes.length * minFee;

        if (msg.value < requestsFee) {
           revert FeeNotEnough(minFee, keyIndexes.length, msg.value);
        }

        uint256 refund = msg.value - requestsFee;

        uint256 lastDeliveredKeyIndex = requestStatus.deliveredItemsCount - 1;

        bytes memory pubkeys = new bytes(keyIndexes.length * PUBLIC_KEY_LENGTH);

        for (uint256 i = 0; i < keyIndexes.length; i++) {
            if (keyIndexes[i] > lastDeliveredKeyIndex) {
                revert KeyWasNotUnpacked(keyIndexes[i], lastDeliveredKeyIndex);
            }
            uint256 requestOffset = keyIndexes[i] * PACKED_REQUEST_LENGTH + 16;

            for (uint256 j = 0; j < PUBLIC_KEY_LENGTH; j++) {
                pubkeys[i * PUBLIC_KEY_LENGTH + j] = data[requestOffset + j];

            }
        }

        IWithdrawalVault(withdrawalVaultAddr).addFullWithdrawalRequests{value: requestsFee}(pubkeys);

        if (refund > 0) {
          (bool success, ) = msg.sender.call{value: refund}("");
          require(success, "Refund failed");
          revert TriggerableWithdrawalRefundFailed();
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