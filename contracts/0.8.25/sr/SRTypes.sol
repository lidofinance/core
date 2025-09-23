// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {STASStorage} from "contracts/0.8.25/stas/STASTypes.sol";

/**
 * @title StakingRouter shared types
 * @author KRogLA
 */

/// @dev Since `enum` is `uint8` by nature, so the `status` is stored as `uint8` to avoid
///      possible problems when upgrading. But for human readability, we use `enum` as
///      function parameter type. More about conversion in the docs:
///      https://docs.soliditylang.org/en/v0.8.17/types.html#enums
enum StakingModuleStatus {
    Active, // deposits and rewards allowed
    DepositsPaused, // deposits NOT allowed, rewards allowed
    Stopped // deposits and rewards NOT allowed

}

/// @dev Type identifier for modules
///      For simplicity, only one deposit type is allowed per module.
///      Legacy - keys count-based accounting, old IStakingModule, WC type 0x01
///      New - balance-based accounting, new IStakingModuleV2, WC type 0x02
enum StakingModuleType {
    Legacy,
    New
}

enum Strategies {
    Deposit,
    Withdrawal,
    Reward
}

enum Metrics {
    DepositTargetShare,
    WithdrawalProtectShare
}

/// @notice Configuration parameters for a staking module.
/// @dev Used when adding or updating a staking module to set operational limits, fee parameters,
///      and withdrawal credential type.
struct StakingModuleConfig {
    /// @notice Maximum stake share that can be allocated to a module, in BP.
    /// @dev Must be less than or equal to TOTAL_BASIS_POINTS (10_000 BP = 100%).
    uint256 stakeShareLimit;
    /// @notice Module's share threshold, upon crossing which, exits of validators from the module will be prioritized, in BP.
    /// @dev Must be less than or equal to TOTAL_BASIS_POINTS (10_000 BP = 100%) and
    ///      greater than or equal to `stakeShareLimit`.
    uint256 priorityExitShareThreshold;
    /// @notice Part of the fee taken from staking rewards that goes to the staking module, in BP.
    /// @dev Together with `treasuryFee`, must not exceed TOTAL_BASIS_POINTS.
    uint256 stakingModuleFee;
    /// @notice Part of the fee taken from staking rewards that goes to the treasury, in BP.
    /// @dev Together with `stakingModuleFee`, must not exceed TOTAL_BASIS_POINTS.
    uint256 treasuryFee;
    /// @notice The maximum number of validators that can be deposited in a single block.
    /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
    ///      Value must not exceed type(uint64).max.
    uint256 maxDepositsPerBlock;
    /// @notice The minimum distance between deposits in blocks.
    /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
    ///      Value must be > 0 and ≤ type(uint64).max.
    uint256 minDepositBlockDistance;
    /// @notice The type of staking module (Legacy/Standard), defines the module interface and withdrawal credentials type.
    /// @dev 0 = Legacy, 0x01 withdrawals, 1 = New, 0x02 withdrawals.
    /// @dev See {StakingModuleType} enum.
    uint256 moduleType;
}

/// @dev old data struct, kept for backward compatibility
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
    /// @notice The type of staking module (Legacy/Standard), defines the module interface and withdrawal credentials type.
    /// @dev 0 = Legacy, 0x01 withdrawals, 1 = New, 0x02 withdrawals.
    /// @dev See {StakingModuleType} enum.
    uint8 moduleType;
    /// @notice The type of withdrawal credentials for creation of validators
    uint8 withdrawalCredentialsType;
}

/// @dev 1 storage slot
struct ModuleStateConfig {
    /// @notice Address of the staking module.
    address moduleAddress;
    /// @notice Part of the fee taken from staking rewards that goes to the staking module.
    uint16 moduleFee;
    /// @notice Part of the fee taken from staking rewards that goes to the treasury.
    uint16 treasuryFee;
    /// @notice Maximum stake share that can be allocated to a module, in BP.
    uint16 depositTargetShare;
    /// @notice Module's share threshold, upon crossing which, exits of validators from the module will be prioritized, in BP.
    uint16 withdrawalProtectShare;
    /// @notice Staking module status if staking module can not accept the deposits or can
    ///         participate in further reward distribution.
    StakingModuleStatus status;
    /// @notice Staking module type (Legacy/Standard)
    StakingModuleType moduleType;
}
// /// @notice The type of withdrawal credentials for creation of validators
// uint8 wcType;
// uint8 _reserved;

/// @dev 1 storage slot
struct ModuleStateDeposits {
    /// @notice block.timestamp of the last deposit of the staking module.
    /// @dev NB: lastDepositAt gets updated even if the deposit value was 0 and no actual deposit happened.
    uint64 lastDepositAt;
    /// @notice block.number of the last deposit of the staking module.
    /// @dev NB: lastDepositBlock gets updated even if the deposit value was 0 and no actual deposit happened.
    uint64 lastDepositBlock;
    /// @notice Current effective balance of the staking module, in Gwei.
    /// @dev renamed from `exitedValidatorsCount` to `effectiveBalanceGwei`
    /// @notice The maximum number of validators that can be deposited in a single block.
    /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
    /// See docs for the `OracleReportSanityChecker.setAppearedValidatorsPerDayLimit` function.
    uint64 maxDepositsPerBlock;
    /// @notice The minimum distance between deposits in blocks.
    /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
    /// See docs for the `OracleReportSanityChecker.setAppearedValidatorsPerDayLimit` function).
    uint64 minDepositBlockDistance;
}

struct ModuleStateAccounting {
    /// @notice Effective balance of the staking module, in Gwei.
    uint96 clBalanceGwei;
    uint96 activeBalanceGwei;
    /// @notice Number of exited validators for Legacy modules
    uint64 exitedValidatorsCount;
}

struct ModuleState {
    /// @notice module config data
    ModuleStateConfig config; // slot 0
    /// @notice deposits state data
    ModuleStateDeposits deposits; // slot 1
    /// @notice accounting state data
    ModuleStateAccounting accounting; // slot 2
    /// @notice Name of the staking module.
    string name; // slot 3
}

struct RouterStorage {
    // moduleId => ModuleState
    mapping(uint256 => ModuleState) moduleStates;
    STASStorage stas;
    uint96 totalClBalanceGwei;
    uint96 totalActiveBalanceGwei;
    bytes32 withdrawalCredentials;
    bytes32 withdrawalCredentials02;
    address lido;
    uint24 lastModuleId;
}

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

/// @notice A collection of the staking module data stored across the StakingRouter and the
/// staking module contract.
///
/// @dev This data, first of all, is designed for off-chain usage and might be redundant for
/// on-chain calls. Give preference for dedicated methods for gas-efficient on-chain calls.
struct StakingModuleDigest {
    /// @notice The number of node operators registered in the staking module.
    uint256 nodeOperatorsCount;
    /// @notice The number of node operators registered in the staking module in active state.
    uint256 activeNodeOperatorsCount;
    /// @notice The current state of the staking module taken from the StakingRouter.
    StakingModule state;
    /// @notice A summary of the staking module's validators.
    StakingModuleSummary summary;
}

/// @notice A collection of the node operator data stored in the staking module.
/// @dev This data, first of all, is designed for off-chain usage and might be redundant for
/// on-chain calls. Give preference for dedicated methods for gas-efficient on-chain calls.
struct NodeOperatorDigest {
    /// @notice Id of the node operator.
    uint256 id;
    /// @notice Shows whether the node operator is active or not.
    bool isActive;
    /// @notice A summary of node operator and its validators.
    NodeOperatorSummary summary;
}

struct ValidatorsCountsCorrection {
    /// @notice The expected current number of exited validators of the module that is
    /// being corrected.
    uint256 currentModuleExitedValidatorsCount;
    /// @notice The expected current number of exited validators of the node operator
    /// that is being corrected.
    uint256 currentNodeOperatorExitedValidatorsCount;
    /// @notice The corrected number of exited validators of the module.
    uint256 newModuleExitedValidatorsCount;
    /// @notice The corrected number of exited validators of the node operator.
    uint256 newNodeOperatorExitedValidatorsCount;
}

struct ValidatorExitData {
    uint256 stakingModuleId;
    uint256 nodeOperatorId;
    bytes pubkey;
}
