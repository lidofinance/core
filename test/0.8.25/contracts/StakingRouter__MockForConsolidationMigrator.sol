// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {StakingModule} from "contracts/0.8.25/sr/SRTypes.sol";

contract StakingRouter__MockForConsolidationMigrator {
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
            withdrawalCredentialsType: 0,
            validatorsBalanceGwei: 0
        });
    }

    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory) {
        return _modules[_stakingModuleId];
    }
}
