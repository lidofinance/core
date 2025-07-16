// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IValidatorsExitBus} from "contracts/common/interfaces/IValidatorsExitBus.sol";

error RequestsNotDelivered();

struct MockExitRequestData {
    bytes pubkey;
    uint256 nodeOpId;
    uint256 moduleId;
    uint256 valIndex;
}

contract ValidatorsExitBusOracle_Mock is IValidatorsExitBus {
    bytes32 private _hash;
    uint256 private _deliveryTimestamp;
    MockExitRequestData[] private _data;

    // Empty implementations for interface functions
    function SUBMIT_REPORT_HASH_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function EXIT_REQUEST_LIMIT_MANAGER_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function PAUSE_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function RESUME_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function DATA_FORMAT_LIST() external pure returns (uint256) {
        return 0;
    }
    function EXIT_TYPE() external pure returns (uint256) {
        return 0;
    }
    function MANAGE_CONSENSUS_CONTRACT_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function MANAGE_CONSENSUS_VERSION_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function SECONDS_PER_SLOT() external pure returns (uint256) {
        return 0;
    }
    function GENESIS_TIME() external pure returns (uint256) {
        return 0;
    }

    function submitExitRequestsHash(bytes32 exitRequestsHash) external {}
    function submitExitRequestsData(ExitRequestsData calldata request) external {}
    function triggerExits(
        ExitRequestsData calldata exitsData,
        uint256[] calldata exitDataIndexes,
        address refundRecipient
    ) external payable {}
    function setExitRequestLimit(
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) external {}
    function getExitRequestLimitFullInfo() external pure returns (uint256, uint256, uint256, uint256, uint256) {
        return (0, 0, 0, 0, 0);
    }
    function setMaxValidatorsPerReport(uint256 maxRequests) external {}
    function getMaxValidatorsPerReport() external pure returns (uint256) {
        return 0;
    }
    function resume() external {}
    function pauseFor(uint256 _duration) external {}
    function pauseUntil(uint256 _pauseUntilInclusive) external {}
    function getTotalRequestsProcessed() external pure returns (uint256) {
        return 0;
    }
    function discardConsensusReport(uint256 refSlot) external {}
    function getConsensusContract() external pure returns (address) {
        return address(0);
    }
    function getConsensusReport()
        external
        pure
        returns (bytes32 hash, uint256 refSlot, uint256 processingDeadlineTime, bool processingStarted)
    {
        return (bytes32(0), 0, 0, false);
    }
    function getConsensusVersion() external pure returns (uint256) {
        return 0;
    }
    function getLastProcessingRefSlot() external pure returns (uint256) {
        return 0;
    }
    function setConsensusContract(address addr) external {}
    function setConsensusVersion(uint256 version) external {}
    function submitConsensusReport(bytes32 report, uint256 refSlot, uint256 deadline) external {}
    function getRoleAdmin(bytes32 role) external pure returns (bytes32) {
        return bytes32(0);
    }
    function getRoleMember(bytes32 role, uint256 index) external pure returns (address) {
        return address(0);
    }
    function getRoleMemberCount(bytes32 role) external pure returns (uint256) {
        return 0;
    }
    function grantRole(bytes32 role, address account) external {}
    function hasRole(bytes32 role, address account) external pure returns (bool) {
        return false;
    }
    function renounceRole(bytes32 role, address account) external {}
    function revokeRole(bytes32 role, address account) external {}

    function setExitRequests(
        bytes32 exitRequestsHash,
        uint256 deliveryTimestamp,
        MockExitRequestData[] calldata data
    ) external {
        _hash = exitRequestsHash;

        _deliveryTimestamp = deliveryTimestamp;

        delete _data;
        for (uint256 i = 0; i < data.length; i++) {
            _data.push(data[i]);
        }
    }

    function getDeliveryTimestamp(bytes32 exitRequestsHash) external view returns (uint256 timestamp) {
        require(exitRequestsHash == _hash, "Mock error, Invalid exitRequestsHash");
        if (_deliveryTimestamp == 0) {
            revert RequestsNotDelivered();
        }
        return _deliveryTimestamp;
    }

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external pure override returns (bytes memory, uint256, uint256, uint256) {
        revert("Not implemented");
        return (bytes(""), 0, 0, 0);
    }

    // TODO: fix upon unit tests fixes
    // function unpackExitRequest(
    //     bytes calldata exitRequests,
    //     uint256 dataFormat,
    //     uint256 index
    // ) external pure override returns (bytes memory, uint256, uint256, uint256) {
    //     require(keccak256(abi.encode(exitRequests, dataFormat)) == _hash, "Mock error, Invalid exitRequestsHash");

    //     MockExitRequestData memory data = _data[index];
    //     return (data.pubkey, data.nodeOpId, data.moduleId, data.valIndex);
    // }
}
