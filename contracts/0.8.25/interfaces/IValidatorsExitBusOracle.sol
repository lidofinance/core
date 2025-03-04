// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

struct DeliveryHistory {
    uint256 blockNumber;
    uint64 blockTimestamp;
    // Key index in exit request array
    uint256 lastDeliveredKeyIndex;
}

struct RequestStatus {
    uint256 totalItemsCount;
    // Total processed items in report
    uint256 deliveredItemsCount;
    // The format of report data
    uint256 reportDataFormat;
    // Vebo contract version at the time of report submittion
    uint256 contractVersion;
    DeliveryHistory[] deliveryHistory;
}

interface IValidatorsExitBusOracle {
    function getExitRequestsStatus(bytes32 exitRequestsHash) external returns (RequestStatus memory);
}
