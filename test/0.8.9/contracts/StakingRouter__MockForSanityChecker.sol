// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {StakingModule} from "contracts/0.8.25/sr/SRTypes.sol";

contract StakingRouter__MockForSanityChecker {
    mapping(uint256 => StakingModule) private modules;
    mapping(uint256 => bool) private moduleExistsById;

    uint256[] private moduleIds;

    constructor() {}

    function mock__addStakingModuleExitedValidators(uint24 moduleId, uint256 exitedValidators) external {
        StakingModule memory module = StakingModule(
            moduleId,
            address(0),
            0,
            0,
            0,
            0,
            "",
            0,
            0,
            exitedValidators,
            0,
            0,
            0,
            1,
            0,
            0
        );
        modules[moduleId] = module;
        moduleExistsById[moduleId] = true;
        moduleIds.push(moduleId);
    }

    function mock__removeStakingModule(uint256 moduleId) external {
        for (uint256 i = 0; i < moduleIds.length; i++) {
            if (moduleIds[i] == moduleId) {
                // Move the last element into the place to delete
                moduleIds[i] = moduleIds[moduleIds.length - 1];
                // Remove the last element
                moduleIds.pop();
                break;
            }
        }
        delete modules[moduleId];
        delete moduleExistsById[moduleId];
    }

    function getStakingModuleIds() external view returns (uint256[] memory) {
        return moduleIds;
    }

    function getStakingModule(uint256 stakingModuleId) public view returns (StakingModule memory module) {
        return modules[stakingModuleId];
    }

    function hasStakingModule(uint256 stakingModuleId) external view returns (bool) {
        return moduleExistsById[stakingModuleId];
    }

    function getStakingModuleStateAccounting(
        uint256 stakingModuleId
    ) external view returns (uint64 validatorsBalanceGwei, uint64 pendingBalanceGwei, uint64 exitedValidatorsCount) {
        return (0, 0, uint64(modules[stakingModuleId].exitedValidatorsCount));
    }
}
