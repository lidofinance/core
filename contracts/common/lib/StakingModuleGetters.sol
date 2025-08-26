// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.8.25;

import {IStakingModule} from "../interfaces/IStakingModule.sol";

/// @notice A summary of the staking module's validators.
struct StakingModuleSummary {
    /// @notice The total number of validators in the EXITED state on the Consensus Layer.
    /// @dev This value can't decrease in normal conditions.
    uint256 totalExitedValidators;
    /// @notice The total number of validators deposited via the official Deposit Contract.
    /// @dev This value is a cumulative counter: even when the validator goes into EXITED state this
    /// counter is not decreasing.
    uint256 totalDepositedValidators;
    /// @notice The number of validators in the set available for deposit
    uint256 depositableValidatorsCount;
}

struct StakingModule {
    /// @notice Unique id of the staking module.
    uint24 id;
    /// @notice Address of the staking module.
    address stakingModuleAddress;
    /// @notice Part of the fee taken from staking rewards that goes to the staking module.
    uint16 stakingModuleFee;
    /// @notice Part of the fee taken from staking rewards that goes to the treasury.
    uint16 treasuryFee;
    /// @notice Maximum stake share that can be allocated to a module, in BP.
    /// @dev Formerly known as `targetShare`.
    uint16 stakeShareLimit;
    /// @notice Staking module status if staking module can not accept the deposits or can
    /// participate in further reward distribution.
    uint8 status;
    /// @notice Name of the staking module.
    string name;
    /// @notice block.timestamp of the last deposit of the staking module.
    /// @dev NB: lastDepositAt gets updated even if the deposit value was 0 and no actual deposit happened.
    uint64 lastDepositAt;
    /// @notice block.number of the last deposit of the staking module.
    /// @dev NB: lastDepositBlock gets updated even if the deposit value was 0 and no actual deposit happened.
    uint256 lastDepositBlock;
    /// @notice Number of exited validators.
    uint256 exitedValidatorsCount;
    /// @notice Module's share threshold, upon crossing which, exits of validators from the module will be prioritized, in BP.
    uint16 priorityExitShareThreshold;
    /// @notice The maximum number of validators that can be deposited in a single block.
    /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
    /// See docs for the `OracleReportSanityChecker.setAppearedValidatorsPerDayLimit` function.
    uint64 maxDepositsPerBlock;
    /// @notice The minimum distance between deposits in blocks.
    /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
    /// See docs for the `OracleReportSanityChecker.setAppearedValidatorsPerDayLimit` function).
    uint64 minDepositBlockDistance;
    /// @notice The type of withdrawal credentials for creation of validators
    // TODO: use some enum type?
    uint8 withdrawalCredentialsType;
}

/// @notice A summary of node operator and its validators.
struct NodeOperatorSummary {
    /// @notice Shows whether the current target limit applied to the node operator.
    uint256 targetLimitMode;
    /// @notice Relative target active validators limit for operator.
    uint256 targetValidatorsCount;
    /// @notice The number of validators with an expired request to exit time.
    /// @dev [deprecated] Stuck key processing has been removed, this field is no longer used.
    uint256 stuckValidatorsCount;
    /// @notice The number of validators that can't be withdrawn, but deposit costs were
    /// compensated to the Lido by the node operator.
    /// @dev [deprecated] Refunded validators processing has been removed, this field is no longer used.
    uint256 refundedValidatorsCount;
    /// @notice A time when the penalty for stuck validators stops applying to node operator rewards.
    /// @dev [deprecated] Stuck key processing has been removed, this field is no longer used.
    uint256 stuckPenaltyEndTimestamp;
    /// @notice The total number of validators in the EXITED state on the Consensus Layer.
    /// @dev This value can't decrease in normal conditions.
    uint256 totalExitedValidators;
    /// @notice The total number of validators deposited via the official Deposit Contract.
    /// @dev This value is a cumulative counter: even when the validator goes into EXITED state this
    /// counter is not decreasing.
    uint256 totalDepositedValidators;
    /// @notice The number of validators in the set available for deposit.
    uint256 depositableValidatorsCount;
}

/// @notice
library StakingModuleGetters {
    /// @notice Returns all-validators summary in the staking module.
    /// @param stakingModuleAddress Address of staking module
    /// @return summary Staking module summary.
    function getStakingModulesValidatorsSummary(
        // TODO: consider pass position to slot and read by index, than return syakingModule
        address stakingModuleAddress
    ) public view returns (StakingModuleSummary memory summary) {
        IStakingModule stakingModule = IStakingModule(stakingModuleAddress);
        (
            summary.totalExitedValidators,
            summary.totalDepositedValidators,
            summary.depositableValidatorsCount
        ) = _getStakingModuleSummary(stakingModule);
    }

    /// @notice Returns node operator summary from the staking module.
    /// @param stakingModuleAddress Address of staking module
    /// @param _nodeOperatorId Id of the node operator to return summary for.
    /// @return summary Node operator summary.
    function getNodeOperatorSummary(
        address stakingModuleAddress,
        uint256 _nodeOperatorId
    ) public view returns (NodeOperatorSummary memory summary) {
        IStakingModule stakingModule = IStakingModule(stakingModuleAddress);
        /// @dev using intermediate variables below due to "Stack too deep" error in case of
        /// assigning directly into the NodeOperatorSummary struct
        (
            uint256 targetLimitMode,
            uint256 targetValidatorsCount,
            ,
            ,
            ,
            /* uint256 stuckValidatorsCount */ /* uint256 refundedValidatorsCount */ /* uint256 stuckPenaltyEndTimestamp */ uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        ) = stakingModule.getNodeOperatorSummary(_nodeOperatorId);
        summary.targetLimitMode = targetLimitMode;
        summary.targetValidatorsCount = targetValidatorsCount;
        summary.totalExitedValidators = totalExitedValidators;
        summary.totalDepositedValidators = totalDepositedValidators;
        summary.depositableValidatorsCount = depositableValidatorsCount;
    }

    /// @dev Optimizes contract deployment size by wrapping the 'stakingModule.getStakingModuleSummary' function.
    function _getStakingModuleSummary(IStakingModule stakingModule) internal view returns (uint256, uint256, uint256) {
        return stakingModule.getStakingModuleSummary();
    }
}
