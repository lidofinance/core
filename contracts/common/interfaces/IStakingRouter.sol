// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

interface IStakingRouter {

    enum StakingModuleStatus {
        Active, // deposits and rewards allowed
        DepositsPaused, // deposits NOT allowed, rewards allowed
        Stopped // deposits and rewards NOT allowed
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

    struct StakingModuleCache {
        address stakingModuleAddress;
        uint24 stakingModuleId;
        uint16 stakingModuleFee;
        uint16 treasuryFee;
        uint16 stakeShareLimit;
        StakingModuleStatus status;
        uint256 activeValidatorsCount;
        uint256 availableValidatorsCount;
    }

    struct ValidatorExitData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        bytes pubkey;
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

    function MANAGE_WITHDRAWAL_CREDENTIALS_ROLE() external view returns (bytes32);
    function STAKING_MODULE_MANAGE_ROLE() external view returns (bytes32);
    function STAKING_MODULE_UNVETTING_ROLE() external view returns (bytes32);
    function REPORT_EXITED_VALIDATORS_ROLE() external view returns (bytes32);
    function REPORT_VALIDATOR_EXITING_STATUS_ROLE() external view returns (bytes32);
    function REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE() external view returns (bytes32);
    function UNSAFE_SET_EXITED_VALIDATORS_ROLE() external view returns (bytes32);
    function REPORT_REWARDS_MINTED_ROLE() external view returns (bytes32);

    function FEE_PRECISION_POINTS() external view returns (uint256);
    function TOTAL_BASIS_POINTS() external view returns (uint256);
    function MAX_STAKING_MODULES_COUNT() external view returns (uint256);
    function MAX_STAKING_MODULE_NAME_LENGTH() external view returns (uint256);

    function initialize(address _admin, address _lido, bytes32 _withdrawalCredentials) external;
    function finalizeUpgrade_v3() external;
    function getLido() external view returns (address);
    function addStakingModule(
        string calldata _name,
        address _stakingModuleAddress,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) external;
    function updateStakingModule(
        uint256 _stakingModuleId,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) external;
    function updateTargetValidatorsLimits(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _targetLimitMode,
        uint256 _targetLimit
    ) external;
    function reportRewardsMinted(uint256[] calldata _stakingModuleIds, uint256[] calldata _totalShares) external;
    function updateExitedValidatorsCountByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _exitedValidatorsCounts
    ) external returns (uint256);
    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    ) external;
    function unsafeSetExitedValidatorsCount(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bool _triggerUpdateFinish,
        ValidatorsCountsCorrection memory _correction
    ) external;
    function onValidatorsCountsByNodeOperatorReportingFinished() external;
    function decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external;
    function getStakingModules() external view returns (StakingModule[] memory res);
    function getStakingModuleIds() external view returns (uint256[] memory stakingModuleIds);
    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory);
    function getStakingModulesCount() external view returns (uint256);
    function hasStakingModule(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleStatus(uint256 _stakingModuleId) external view returns (StakingModuleStatus);
    function getStakingModuleSummary(uint256 _stakingModuleId) external view returns (StakingModuleSummary memory summary);
    function getNodeOperatorSummary(uint256 _stakingModuleId, uint256 _nodeOperatorId) external view returns (NodeOperatorSummary memory summary);
    function getAllStakingModuleDigests() external view returns (StakingModuleDigest[] memory);
    function getStakingModuleDigests(uint256[] memory _stakingModuleIds) external view returns (StakingModuleDigest[] memory digests);
    function getAllNodeOperatorDigests(uint256 _stakingModuleId) external view returns (NodeOperatorDigest[] memory);
    function getNodeOperatorDigests(uint256 _stakingModuleId, uint256 _offset, uint256 _limit) external view returns (NodeOperatorDigest[] memory);
    function getNodeOperatorDigests(uint256 _stakingModuleId, uint256[] memory _nodeOperatorIds) external view returns (NodeOperatorDigest[] memory digests);
    function setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status) external;
    function getStakingModuleIsStopped(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleIsDepositsPaused(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleIsActive(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleNonce(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleLastDepositBlock(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleMinDepositBlockDistance(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleMaxDepositsPerBlock(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleActiveValidatorsCount(uint256 _stakingModuleId) external view returns (uint256 activeValidatorsCount);
    function getStakingModuleMaxDepositsCount(uint256 _stakingModuleId, uint256 _maxDepositsValue) external view returns (uint256);
    function getStakingFeeAggregateDistribution() external view returns (uint96 modulesFee, uint96 treasuryFee, uint256 basePrecision);
    function getStakingRewardsDistribution() external view returns (
        address[] memory recipients,
        uint256[] memory stakingModuleIds,
        uint96[] memory stakingModuleFees,
        uint96 totalFee,
        uint256 precisionPoints
    );
    function getTotalFeeE4Precision() external view returns (uint16 totalFee);
    function getStakingFeeAggregateDistributionE4Precision() external view returns (uint16 modulesFee, uint16 treasuryFee);
    function getDepositsAllocation(uint256 _depositsCount) external view returns (uint256 allocated, uint256[] memory allocations);
    function deposit(uint256 _depositsCount, uint256 _stakingModuleId, bytes calldata _depositCalldata) external payable;
    function setWithdrawalCredentials(bytes32 _withdrawalCredentials) external;
    function getWithdrawalCredentials() external view returns (bytes32);
    function reportValidatorExitDelay(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) external;
    function onValidatorExitTriggered(
        ValidatorExitData[] calldata validatorExitData,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external;
}
