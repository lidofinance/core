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

    struct ExitLimits {
        /// @notice Maximum limit value for exits that will be processed through the CL
        /// TODO: @dev Must fit into uint16 (<= 65_535) ? Is this value the same as exitedValidatorsPerDayLimit; in OracleReportSanityChecker
        uint256 maxExitRequestsLimit;
        /// @notice Exit limit increase per block for exits that will be processed through the CL
        /// @dev This value will be used for limit replenishment
        uint256 exitRequestsLimitIncreasePerBlock;
        /// @notice Maximum limit value for exits that will be processed via TW (eip-7002)
        /// TODO: @dev Must fit into uint16 (<= 65_535) ? Is this value the same as exitedValidatorsPerDayLimit; in OracleReportSanityChecker
        uint256 maxTWExitRequestsLimit;
        /// @notice Exit limit increase per block for exits that will be processed via TW (eip-7002)
        uint256 twExitRequestsLimitIncreasePerBlock;
    }

    function submitReportHash(bytes32 exitReportHash) external;

    function emitExitEvents(ExitRequestData calldata request) external;

    function triggerExits(ExitRequestData calldata request, uint256[] calldata keyIndexes) external payable;

    function triggerExitsDirectly(DirectExitData calldata exitData) external payable returns (uint256);

    function setExitRequestLimit(ExitLimits calldata limits) external;

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
