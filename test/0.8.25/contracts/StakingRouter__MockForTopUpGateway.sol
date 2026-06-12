// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

contract StakingRouter__MockForTopUpGateway {
    mapping(uint256 => bytes32) internal withdrawalCredentials;
    mapping(uint256 => bool) internal moduleExists;
    mapping(uint256 => bool) internal moduleIsActive;

    event TopUpCalled(
        uint256 stakingModuleId,
        uint256[] keyIndices,
        uint256[] operatorIds,
        bytes[] pubkeys,
        uint256[] topUpLimits
    );

    uint256 public topUpCalls;

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

    function hasStakingModule(uint256 moduleId) public view returns (bool) {
        return moduleExists[moduleId];
    }

    function canDeposit(uint256 _stakingModuleId) external view returns (bool) {
        return hasStakingModule(_stakingModuleId) && getStakingModuleIsActive(_stakingModuleId);
    }

    function getStakingModuleIsActive(uint256 moduleId) public view returns (bool) {
        return moduleIsActive[moduleId];
    }

    function topUp(
        uint256 _stakingModuleId,
        uint256[] calldata _keyIndices,
        uint256[] calldata _operatorIds,
        bytes[] calldata _pubkeys,
        uint256[] calldata _topUpLimits
    ) external {
        unchecked {
            ++topUpCalls;
        }

        emit TopUpCalled(_stakingModuleId, _keyIndices, _operatorIds, _pubkeys, _topUpLimits);
    }
}
