// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IValidatorsExitBus, DeliveryHistory} from "contracts/0.8.25/interfaces/IValidatorsExitBus.sol";

struct MockExitRequestData {
    bytes pubkey;
    uint256 nodeOpId;
    uint256 moduleId;
    uint256 valIndex;
}

contract ValidatorsExitBusOracle_Mock is IValidatorsExitBus {
    bytes32 _hash;
    DeliveryHistory[] private _deliveryHistory;
    MockExitRequestData[] private _data;

    function setExitRequests(
        bytes32 exitRequestsHash,
        DeliveryHistory[] calldata deliveryHistory,
        MockExitRequestData[] calldata data
    ) external {
        _hash = exitRequestsHash;

        for (uint256 i = 0; i < deliveryHistory.length; i++) {
            _deliveryHistory.push(deliveryHistory[i]);
        }

        for (uint256 i = 0; i < data.length; i++) {
            _data.push(data[i]);
        }
    }

    function getExitRequestsDeliveryHistory(bytes32 exitRequestsHash) external view returns (DeliveryHistory[] memory) {
        require(exitRequestsHash == _hash, "Mock error, Invalid exitRequestsHash");
        return _deliveryHistory;
    }

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external view override returns (bytes memory, uint256, uint256, uint256) {
        require(keccak256(abi.encode(exitRequests, dataFormat)) == _hash, "Mock error, Invalid exitRequestsHash");

        MockExitRequestData memory data = _data[index];
        return (data.pubkey, data.nodeOpId, data.moduleId, data.valIndex);
    }
}

library ExitRequests {
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    error ExitRequestIndexOutOfRange(uint256 exitRequestIndex);

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 exitRequestIndex
    ) internal pure returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) {
        if (exitRequestIndex >= count(exitRequests)) {
            revert ExitRequestIndexOutOfRange(exitRequestIndex);
        }

        uint256 itemOffset;
        uint256 dataWithoutPubkey;

        assembly {
            // Compute the start of this packed request (item)
            itemOffset := add(exitRequests.offset, mul(PACKED_REQUEST_LENGTH, exitRequestIndex))

            // Load the first 16 bytes which contain moduleId (24 bits),
            // nodeOpId (40 bits), and valIndex (64 bits).
            dataWithoutPubkey := shr(128, calldataload(itemOffset))
        }

        // dataWithoutPubkey format (128 bits total):
        // MSB <-------------------- 128 bits --------------------> LSB
        // |   128 bits: zeros  | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |

        valIndex = uint64(dataWithoutPubkey);
        nodeOpId = uint40(dataWithoutPubkey >> 64);
        moduleId = uint24(dataWithoutPubkey >> (64 + 40));

        // Allocate a new bytes array in memory for the pubkey
        pubkey = new bytes(PUBLIC_KEY_LENGTH);

        assembly {
            // Starting offset in calldata for the pubkey part
            let pubkeyCalldataOffset := add(itemOffset, 16)

            // Memory location of the 'pubkey' bytes array data
            let pubkeyMemPtr := add(pubkey, 32)

            // Copy the 48 bytes of the pubkey from calldata into memory
            calldatacopy(pubkeyMemPtr, pubkeyCalldataOffset, PUBLIC_KEY_LENGTH)
        }

        return (pubkey, nodeOpId, moduleId, valIndex);
    }

    /**
     * @dev Counts how many exit requests are packed in the given calldata array.
     */
    function count(bytes calldata exitRequests) internal pure returns (uint256) {
        return exitRequests.length / PACKED_REQUEST_LENGTH;
    }
}
