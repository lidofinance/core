// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

struct DeliveryHistory {
    uint64 timestamp;
    // Key index in exit request array
    uint256 lastDeliveredKeyIndex;
}

struct RequestStatus {
    uint256 totalItemsCount;
    uint256 deliveredItemsCount;
    uint256 reportDataFormat;
    uint256 contractVersion;
    DeliveryHistory[] deliveryHistory;
}

interface IValidatorsExitBusOracle {
    function getExitRequestsStatus(bytes32 exitRequestsHash) external view returns (RequestStatus memory);
}
