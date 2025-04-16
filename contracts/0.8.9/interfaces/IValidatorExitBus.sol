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

    function submitReportHash(bytes32 exitReportHash) external;

    function emitExitEvents(ExitRequestData calldata request, uint256 contractVersion) external;

    function triggerExits(ExitRequestData calldata request, uint256[] calldata keyIndexes) external payable;

    function triggerExitsDirectly(DirectExitData calldata exitData) external payable returns (uint256);

    function setExitReportLimit(uint256 _maxExitRequestsLimit, uint256 _exitRequestsLimitIncreasePerBlock) external;

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
