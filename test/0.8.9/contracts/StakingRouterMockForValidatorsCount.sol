// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.9;

import {StakingRouter} from "contracts/0.8.9/StakingRouter.sol";

interface IStakingRouter {

    function getStakingModuleIds() external view returns (uint256[] memory);

    function getStakingModuleSummary(uint256 stakingModuleId) external view
        returns (StakingRouter.StakingModuleSummary memory summary);
}


contract StakingRouterMockForValidatorsCount is IStakingRouter {

    mapping(uint256 => StakingRouter.StakingModuleSummary) private modules;

    uint256[] private moduleIds;

    constructor() {
    }

    function addStakingModule(uint256 moduleId, StakingRouter.StakingModuleSummary memory summary) external {
        modules[moduleId] = summary;
        moduleIds.push(moduleId);
    }

    function removeStakingModule(uint256 moduleId) external {
        modules[moduleId] = StakingRouter.StakingModuleSummary(0, 0, 0);
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

    function getStakingModuleSummary(uint256 stakingModuleId)
        external
        view
        returns (StakingRouter.StakingModuleSummary memory summary) {
        return modules[stakingModuleId];
    }
}
