// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";
import {AccountingOracle} from "contracts/0.8.9/oracle/AccountingOracle.sol";

interface ITimeProvider {
    function getTime() external view returns (uint256);
}

contract AccountingOracle__Harness is AccountingOracle, ITimeProvider {
    using UnstructuredStorage for bytes32;

    constructor(
        address lidoLocator,
        uint256 secondsPerSlot,
        uint256 genesisTime
    ) AccountingOracle(lidoLocator, secondsPerSlot, genesisTime) {
        // allow usage without a proxy for tests
        CONTRACT_VERSION_POSITION.setStorageUint256(0);
    }

    function setContractVersion(uint256 version) external {
        CONTRACT_VERSION_POSITION.setStorageUint256(version);
    }

    function getTime() external view returns (uint256) {
        return _getTime();
    }

    function _getTime() internal view override returns (uint256) {
        address consensus = CONSENSUS_CONTRACT_POSITION.getStorageAddress();
        return ITimeProvider(consensus).getTime();
    }

    function getExtraDataProcessingState() external view returns (ExtraDataProcessingState memory) {
        return _storageExtraDataProcessingState().value;
    }
}
