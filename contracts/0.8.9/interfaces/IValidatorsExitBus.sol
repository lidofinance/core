// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

interface IValidatorsExitBus {
    struct ExitRequestData {
        bytes data;
        uint256 dataFormat;
    }

    struct DirectExitData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        bytes validatorsPubkeys;
    }

    struct DeliveryHistory {
        // index in array of requests
        uint256 lastDeliveredKeyIndex;
        uint256 timestamp;
    }

    function submitExitRequestsHash(bytes32 exitReportHash) external;

    function submitExitRequestsData(ExitRequestData calldata request) external;

    function triggerExits(
        ExitRequestData calldata request,
        uint256[] calldata keyIndexes,
        address refundRecipient,
        uint8 exitType
    ) external payable;

    function setExitRequestLimit(uint256 exitsDailyLimit, uint256 twExitsDailyLimit) external;

    function getExitRequestsDeliveryHistory(
        bytes32 exitRequestsHash
    ) external view returns (uint256 totalItemsCount, uint256 deliveredItemsCount, DeliveryHistory[] memory history);

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external view returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex);

    function resume() external;

    function pauseFor(uint256 _duration) external;

    function pauseUntil(uint256 _pauseUntilInclusive) external;
}
