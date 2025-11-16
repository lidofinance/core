// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

contract StakingRouter__MockForTopUpGateway {
    mapping(uint256 => bytes32) internal withdrawalCredentials;

    function setWithdrawalCredentials(uint256 moduleId, bytes32 wc) external {
        withdrawalCredentials[moduleId] = wc;
    }

    function getStakingModuleWithdrawalCredentials(uint256 moduleId) external view returns (bytes32) {
        return withdrawalCredentials[moduleId];
    }
}
