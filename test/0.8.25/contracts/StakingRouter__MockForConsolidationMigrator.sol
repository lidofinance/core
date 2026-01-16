// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

contract StakingRouter__MockForConsolidationMigrator {
    struct StakingModule {
        uint24 id;
        address stakingModuleAddress;
        uint16 stakingModuleFee;
        uint16 treasuryFee;
        uint16 stakeShareLimit;
        uint8 status;
        string name;
        uint64 lastDepositAt;
        uint256 lastDepositBlock;
        uint256 exitedValidatorsCount;
        uint16 priorityExitShareThreshold;
        uint64 maxDepositsPerBlock;
        uint64 minDepositBlockDistance;
        uint8 withdrawalCredentialsType;
    }

    mapping(uint256 => StakingModule) internal _modules;

    function mock__setStakingModule(uint256 moduleId, address moduleAddress) external {
        _modules[moduleId] = StakingModule({
            id: uint24(moduleId),
            stakingModuleAddress: moduleAddress,
            stakingModuleFee: 0,
            treasuryFee: 0,
            stakeShareLimit: 0,
            status: 0,
            name: "",
            lastDepositAt: 0,
            lastDepositBlock: 0,
            exitedValidatorsCount: 0,
            priorityExitShareThreshold: 0,
            maxDepositsPerBlock: 0,
            minDepositBlockDistance: 0,
            withdrawalCredentialsType: 0
        });
    }

    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory) {
        return _modules[_stakingModuleId];
    }
}
