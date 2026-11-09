// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";
import {ValidatorsExitBusOracle} from "contracts/0.8.9/oracle/ValidatorsExitBusOracle.sol";
import {WithdrawalIntent} from "contracts/common/interfaces/WithdrawalIntent.sol";

interface ITimeProvider {
    function getTime() external view returns (uint256);
}

contract ValidatorsExitBus__Harness is ValidatorsExitBusOracle, ITimeProvider {
    using UnstructuredStorage for bytes32;

    constructor(
        uint256 secondsPerSlot,
        uint256 genesisTime,
        address lidoLocator,
        uint256 maxRequestsPerReport
    ) ValidatorsExitBusOracle(secondsPerSlot, genesisTime, lidoLocator, maxRequestsPerReport) {
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

    function setContractVersion(uint256 version) external {
        CONTRACT_VERSION_POSITION.setStorageUint256(version);
    }

    // Expose internal function for unit testing
    function processWithdrawalRequests(
        bytes calldata data
    ) external returns (WithdrawalIntent[] memory intents, uint256 totalExitBalanceEth) {
        return _processWithdrawalRequests(data);
    }
}
