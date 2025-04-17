// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

struct DeliveryHistory {
    uint64 timestamp;
    // Key index in exit request array
    uint256 lastDeliveredKeyIndex;
}

interface IValidatorsExitBusOracle {
    function getExitRequestsDeliveryHistory(
        bytes32 exitRequestsHash
    ) external view returns (uint256 totalItemsCount, uint256 deliveredItemsCount, DeliveryHistory[] memory history);

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external view returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex);
}
