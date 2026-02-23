// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {IStakingRouter} from "contracts/0.8.9/oracle/ValidatorsExitBus.sol";

contract StakingRouter__MockForValidatorsExitBus is IStakingRouter {
    error StakingModuleUnregistered();

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

    function getStakingModuleStateConfig(
        uint256 _stakingModuleId
    ) external view returns (ModuleStateConfig memory stateConfig) {
        _validateModuleId(_stakingModuleId);
        StakingModuleData memory data = _modules[_stakingModuleId];
        return
            ModuleStateConfig({
                moduleAddress: data.stakingModuleAddress,
                moduleFee: data.stakingModuleFee,
                treasuryFee: data.treasuryFee,
                depositTargetShare: data.stakeShareLimit,
                withdrawalProtectShare: data.priorityExitShareThreshold,
                status: data.status,
                withdrawalCredentialsType: data.withdrawalCredentialsType
            });
    }

    function getStakingModuleMaxEB(uint256 _stakingModuleId) external view returns (uint256) {
        _validateModuleId(_stakingModuleId);
        uint8 wcType = _modules[_stakingModuleId].withdrawalCredentialsType;
        if (wcType == 0x01) {
            return 32 ether;
        }
        return 2048 ether;
    }

    function _validateModuleId(uint256 _moduleId) internal view {
        /// @dev we don't care about the module existence (i.e. proper configuration) with `id > 0` in this mock
        if (_moduleId == 0) {
            revert StakingModuleUnregistered();
        }
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
