// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";
import {ValidatorsExitBusOracle} from "contracts/0.8.9/oracle/ValidatorsExitBusOracle.sol";

interface ITimeProvider {
    function getTime() external view returns (uint256);
}

contract ValidatorsExitBus__Harness is ValidatorsExitBusOracle, ITimeProvider {
    using UnstructuredStorage for bytes32;

    constructor(
        uint256 secondsPerSlot,
        uint256 genesisTime,
        address lidoLocator
    ) ValidatorsExitBusOracle(secondsPerSlot, genesisTime, lidoLocator) {
        // allow usage without a proxy for tests
        CONTRACT_VERSION_POSITION.setStorageUint256(0);
    }

    function getTime() external view returns (uint256) {
        return _getTime();
    }

    function _getTime() internal view override returns (uint256) {
        address consensus = CONSENSUS_CONTRACT_POSITION.getStorageAddress();
        uint256 time = ITimeProvider(consensus).getTime();

        return time;
    }

    // Method used in VEB
    function _getTimestamp() internal view override returns (uint32) {
        return uint32(_getTime());
    }

    function getDataProcessingState() external view returns (DataProcessingState memory) {
        return _storageDataProcessingState().value;
    }

    function storeNewHashRequestStatus(bytes32 exitRequestHash, uint8 contractVersion, uint32 timestamp) external {
        _storeNewHashRequestStatus(exitRequestHash, contractVersion, timestamp);
    }

    function setContractVersion(uint256 version) external {
        CONTRACT_VERSION_POSITION.setStorageUint256(version);
    }

    function updateRequestStatus(bytes32 exitRequestHash) external {
        RequestStatus storage requestStatus = _storageRequestStatus()[exitRequestHash];
        _updateRequestStatus(requestStatus);
    }

    function getRequestStatus(bytes32 exitRequestHash) external view returns (RequestStatus memory requestStatus) {
        requestStatus = _storageRequestStatus()[exitRequestHash];
    }
}
