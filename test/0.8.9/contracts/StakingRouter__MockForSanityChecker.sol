// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {StakingRouter} from "contracts/0.8.9/StakingRouter.sol";

contract StakingRouter__MockForSanityChecker {

    mapping(uint256 => StakingRouter.StakingModule) private modules;

    uint256[] private moduleIds;

    constructor() {}

    function mock__addStakingModuleExitedValidators(uint24 moduleId, uint256 exitedValidators) external {
        StakingRouter.StakingModule memory module = StakingRouter.StakingModule(moduleId, address(0), 0, 0, 0, 0, "", 0, 0, exitedValidators, 0, 0, 0);
        modules[moduleId] = module;
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
    }

    function getStakingModuleIds() external view returns (uint256[] memory) {
        return moduleIds;
    }

    function getStakingModule(uint256 stakingModuleId)
    public
    view
    returns (StakingRouter.StakingModule memory module) {
        return modules[stakingModuleId];
    }
}
