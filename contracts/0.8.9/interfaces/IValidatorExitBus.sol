// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

interface IValidatorsExitBus {
    struct ExitRequestData {
        bytes data;
        uint256 dataFormat;
    }

    struct ValidatorExitData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        uint256 validatorIndex;
        bytes validatorPubkey;
    }

    struct DeliveryHistory {
        uint256 lastDeliveredKeyIndex;
        uint256 timestamp;
    }

    function submitReportHash(bytes32 exitReportHash) external;

    function emitExitEvents(ExitRequestData calldata request, uint256 contractVersion) external;

    function triggerExits(ExitRequestData calldata request, uint256[] calldata keyIndexes) external payable;

    function triggerExitsDirectly(ValidatorExitData calldata validator) external payable returns (uint256);

    function setExitReportLimit(uint256 _maxExitRequestsLimit, uint256 _exitRequestsLimitIncreasePerBlock) external;

    function getDeliveryHistory(bytes32 exitReportHash) external view returns (DeliveryHistory[] memory);

    function resume() external;

    function pauseFor(uint256 _duration) external;

    function pauseUntil(uint256 _pauseUntilInclusive) external;
}
