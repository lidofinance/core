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
        return ITimeProvider(consensus).getTime();
    }

    function getDataProcessingState() external view returns (DataProcessingState memory) {
        return _storageDataProcessingState().value;
    }
}
