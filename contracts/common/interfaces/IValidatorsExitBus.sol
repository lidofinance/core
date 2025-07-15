// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v4.4/access/IAccessControlEnumerable.sol";

import {IBaseOracle} from "./IBaseOracle.sol";

interface IValidatorsExitBus is IBaseOracle, IAccessControlEnumerable {
    // Structs
    struct ExitRequestsData {
        bytes data;
        uint256 dataFormat;
    }

    struct ValidatorData {
        uint256 nodeOpId;
        uint256 moduleId;
        uint256 valIndex;
        bytes pubkey;
    }

    struct RequestStatus {
        uint32 contractVersion;
        uint32 deliveredExitDataTimestamp;
    }

    // Errors
    error ZeroArgument(string name);
    error UnsupportedRequestsDataFormat(uint256 format);
    error InvalidRequestsDataLength();
    error InvalidModuleId();
    error InvalidRequestsDataSortOrder();
    error ExitHashNotSubmitted();
    error ExitHashAlreadySubmitted();
    error RequestsAlreadyDelivered();
    error ExitDataIndexOutOfRange(uint256 exitDataIndex, uint256 requestsCount);
    error InvalidExitDataIndexSortOrder();
    error ExitRequestsLimitExceeded(uint256 requestsCount, uint256 remainingLimit);
    error RequestsNotDelivered();
    error TooManyExitRequestsInReport(uint256 requestsCount, uint256 maxRequestsPerReport);

    // Events
    event RequestsHashSubmitted(bytes32 exitRequestsHash);
    event ValidatorExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        uint256 indexed validatorIndex,
        bytes validatorPubkey,
        uint256 timestamp
    );
    event ExitRequestsLimitSet(uint256 maxExitRequestsLimit, uint256 exitsPerFrame, uint256 frameDurationInSec);
    event ExitDataProcessing(bytes32 exitRequestsHash);
    event SetMaxValidatorsPerReport(uint256 maxValidatorsPerReport);

    // Constants (external view functions for public constants)
    function SUBMIT_REPORT_HASH_ROLE() external view returns (bytes32);
    function EXIT_REQUEST_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function PAUSE_ROLE() external view returns (bytes32);
    function RESUME_ROLE() external view returns (bytes32);
    function DATA_FORMAT_LIST() external view returns (uint256);
    function EXIT_TYPE() external view returns (uint256);

    // External functions
    function submitExitRequestsHash(bytes32 exitRequestsHash) external;
    function submitExitRequestsData(ExitRequestsData calldata request) external;
    function triggerExits(
        ExitRequestsData calldata exitsData,
        uint256[] calldata exitDataIndexes,
        address refundRecipient
    ) external payable;
    function setExitRequestLimit(
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) external;
    function getExitRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxExitRequestsLimit,
            uint256 exitsPerFrame,
            uint256 frameDurationInSec,
            uint256 prevExitRequestsLimit,
            uint256 currentExitRequestsLimit
        );
    function setMaxValidatorsPerReport(uint256 maxRequests) external;
    function getMaxValidatorsPerReport() external view returns (uint256);
    function getDeliveryTimestamp(bytes32 exitRequestsHash) external view returns (uint256 deliveryDateTimestamp);
    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external pure returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex);
    function resume() external;
    function pauseFor(uint256 _duration) external;
    function pauseUntil(uint256 _pauseUntilInclusive) external;
    function getTotalRequestsProcessed() external view returns (uint256);
}
