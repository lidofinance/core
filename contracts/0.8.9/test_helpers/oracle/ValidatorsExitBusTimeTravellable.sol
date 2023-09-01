// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;


import { UnstructuredStorage } from "../../lib/UnstructuredStorage.sol";
import { ValidatorsExitBusOracle } from "../../oracle/ValidatorsExitBusOracle.sol";


interface ITimeProvider {
    function getTime() external view returns (uint256);
}


contract ValidatorsExitBusTimeTravellable is ValidatorsExitBusOracle, ITimeProvider {
    using UnstructuredStorage for bytes32;

    constructor(uint256 secondsPerSlot, uint256 genesisTime, address lidoLocator)
        ValidatorsExitBusOracle(secondsPerSlot, genesisTime, lidoLocator)
    {
        // allow usage without a proxy for tests
        CONTRACT_VERSION_POSITION.setStorageUint256(0);
    }

    function getTime() external view returns (uint256) {
        return _getTime();
    }

    function _getTime() internal override view returns (uint256) {
        address consensus = CONSENSUS_CONTRACT_POSITION.getStorageAddress();
        return ITimeProvider(consensus).getTime();
    }

    function getDataProcessingState() external view returns (DataProcessingState memory) {
        return _storageDataProcessingState().value;
    }
}
