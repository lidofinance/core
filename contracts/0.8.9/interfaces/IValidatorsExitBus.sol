// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

interface IValidatorsExitBus {
    struct ExitRequestData {
        bytes data;
        uint256 dataFormat;
    }

    struct DeliveryHistory {
        // index in array of requests
        uint32 lastDeliveredExitDataIndex;
        uint32 timestamp;
    }

    function submitExitRequestsHash(bytes32 exitReportHash) external;

    function submitExitRequestsData(ExitRequestData calldata request) external;

    function triggerExits(
        ExitRequestData calldata exitsData,
        uint256[] calldata exitDataIndexes,
        address refundRecipient
    ) external payable;

    function setExitRequestLimit(uint256 maxExitRequests, uint256 exitsPerFrame, uint256 frameDuration) external;

    function getExitRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxExitRequestsLimit,
            uint256 exitsPerFrame,
            uint256 frameDuration,
            uint256 prevExitRequestsLimit,
            uint256 currentExitRequestsLimit
        );

    function getExitRequestsDeliveryHistory(
        bytes32 exitRequestsHash
    ) external view returns (DeliveryHistory[] memory history);

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external pure returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex);

    function resume() external;

    function pauseFor(uint256 _duration) external;

    function pauseUntil(uint256 _pauseUntilInclusive) external;
}
