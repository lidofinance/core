// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {IStakingRouter} from "contracts/0.8.9/oracle/ValidatorsExitBus.sol";

contract StakingRouter__MockForValidatorsExitBus is IStakingRouter {
    struct StakingModuleData {
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

    mapping(uint256 => StakingModuleData) internal _modules;

    /// @notice Mock function to set up module configuration for tests
    /// @param moduleId The module ID
    /// @param withdrawalCredentialsType The withdrawal credentials type (0x01 or 0x02)
    function setStakingModuleWithdrawalCredentialsType(uint256 moduleId, uint8 withdrawalCredentialsType) external {
        _modules[moduleId].id = uint24(moduleId);
        _modules[moduleId].withdrawalCredentialsType = withdrawalCredentialsType;
        // Set a placeholder address - tests can override with setStakingModuleAddress if needed
        if (_modules[moduleId].stakingModuleAddress == address(0)) {
            _modules[moduleId].stakingModuleAddress = address(uint160(moduleId + 0x1000));
        }
    }

    /// @notice Mock function to set staking module address
    /// @param moduleId The module ID
    /// @param moduleAddress The module address
    function setStakingModuleAddress(uint256 moduleId, address moduleAddress) external {
        _modules[moduleId].stakingModuleAddress = moduleAddress;
    }

    /// @notice Implementation of IStakingRouter.getStakingModule
    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory) {
        StakingModuleData memory data = _modules[_stakingModuleId];

        return
            StakingModule({
                id: data.id,
                stakingModuleAddress: data.stakingModuleAddress,
                stakingModuleFee: data.stakingModuleFee,
                treasuryFee: data.treasuryFee,
                stakeShareLimit: data.stakeShareLimit,
                status: data.status,
                name: data.name,
                lastDepositAt: data.lastDepositAt,
                lastDepositBlock: data.lastDepositBlock,
                exitedValidatorsCount: data.exitedValidatorsCount,
                priorityExitShareThreshold: data.priorityExitShareThreshold,
                maxDepositsPerBlock: data.maxDepositsPerBlock,
                minDepositBlockDistance: data.minDepositBlockDistance,
                withdrawalCredentialsType: data.withdrawalCredentialsType
            });
    }

    // Stub implementations for other IStakingRouter methods (not used in ValidatorsExitBus)
    function updateExitedValidatorsCountByStakingModule(
        uint256[] calldata,
        uint256[] calldata
    ) external pure returns (uint256) {
        revert("Not implemented");
    }

    function getDepositAmountFromLastSlot(uint256) external pure returns (uint256) {
        revert("Not implemented");
    }

    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256,
        bytes calldata,
        bytes calldata
    ) external pure {
        revert("Not implemented");
    }

    function onValidatorsCountsByNodeOperatorReportingFinished() external pure {
        revert("Not implemented");
    }
}
