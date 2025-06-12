// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {StakingRouter} from "contracts/0.8.9/StakingRouter.sol";
import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";

contract StakingRouter__Harness is StakingRouter {
    using UnstructuredStorage for bytes32;

    constructor(address _depositContract) StakingRouter(_depositContract) {}

    function getStakingModuleIndexById(uint256 _stakingModuleId) external view returns (uint256) {
        return _getStakingModuleIndexById(_stakingModuleId);
    }

    function getStakingModuleByIndex(uint256 _stakingModuleIndex) external view returns (StakingModule memory) {
        return _getStakingModuleByIndex(_stakingModuleIndex);
    }

    function testing_setBaseVersion(uint256 version) external {
        CONTRACT_VERSION_POSITION.setStorageUint256(version);
    }

    function testing_setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status) external {
        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
        _setStakingModuleStatus(stakingModule, _status);
    }
}
