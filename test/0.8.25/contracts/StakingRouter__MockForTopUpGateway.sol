// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

contract StakingRouter__MockForTopUpGateway {
    mapping(uint256 => bytes32) internal withdrawalCredentials;
    mapping(uint256 => bool) internal moduleExists;
    mapping(uint256 => bool) internal moduleIsActive;

    function setWithdrawalCredentials(uint256 moduleId, bytes32 wc) external {
        withdrawalCredentials[moduleId] = wc;
        moduleExists[moduleId] = true;
        moduleIsActive[moduleId] = true;
    }

    function setModuleActive(uint256 moduleId, bool active) external {
        moduleExists[moduleId] = true;
        moduleIsActive[moduleId] = active;
    }

    function getStakingModuleWithdrawalCredentials(uint256 moduleId) external view returns (bytes32) {
        return withdrawalCredentials[moduleId];
    }

    function hasStakingModule(uint256 moduleId) external view returns (bool) {
        return moduleExists[moduleId];
    }

    function getStakingModuleIsActive(uint256 moduleId) external view returns (bool) {
        return moduleIsActive[moduleId];
    }
}
