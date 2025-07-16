// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IValidatorsExitBus} from "contracts/0.8.25/ValidatorExitDelayVerifier.sol";

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
        // TODO: rewrite corresponding tests when this functions is pure but view
        // skipped tests:
        // - accepts a valid proof and does not revert
        // - report exit delay with uses earliest possible voluntary exit time when it's greater than exit request timestamp
        // - reverts with 'ExitIsNotEligibleOnProvableBeaconBlock' when the when proof slot is early then exit request time

        revert("Not implemented");
        // require(keccak256(abi.encode(exitRequests, dataFormat)) == _hash, "Mock error, Invalid exitRequestsHash");

        // MockExitRequestData memory data = _data[index];
        // return (data.pubkey, data.nodeOpId, data.moduleId, data.valIndex);
    }
}
