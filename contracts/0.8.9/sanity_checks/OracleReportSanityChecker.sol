// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable one-contract-per-file
pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import {Math256} from "contracts/common/lib/Math256.sol";
import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {PositiveTokenRebaseLimiter, TokenRebaseLimiterData} from "../lib/PositiveTokenRebaseLimiter.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {IVersioned} from "contracts/common/interfaces/IVersioned.sol";

// import {StakingRouter} from "../StakingRouter.sol";
import {ISecondOpinionOracle} from "../interfaces/ISecondOpinionOracle.sol";

interface IWithdrawalQueue {
    struct WithdrawalRequestStatus {
        /// @notice stETH token amount that was locked on withdrawal queue for this request
        uint256 amountOfStETH;
        /// @notice amount of stETH shares locked on withdrawal queue for this request
        uint256 amountOfShares;
        /// @notice address that can claim or transfer this request
        address owner;
        /// @notice timestamp of when the request was created, in seconds
        uint256 timestamp;
        /// @notice true, if request is finalized
        bool isFinalized;
        /// @notice true, if request is claimed. Request is claimable if (isFinalized && !isClaimed)
        bool isClaimed;
    }

    function getWithdrawalStatus(
        uint256[] calldata _requestIds
    ) external view returns (WithdrawalRequestStatus[] memory statuses);
}

interface IBaseOracle {
    function getLastProcessingRefSlot() external view returns (uint256);
}

interface IStakingRouter {
    function getStakingModuleIds() external view returns (uint256[] memory);

    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory);

    function getStakingModuleBalance(uint256 moduleId) external view returns (uint256);

    function getTotalStakingModulesBalance() external view returns (uint256);
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
    /// @dev Must be harmonized with `OracleReportSanityChecker.appearedEthAmountPerDayLimit`.
    /// See docs for the `OracleReportSanityChecker.setAppearedEthAmountPerDayLimit` function.
    uint64 maxDepositsPerBlock;
    /// @notice The minimum distance between deposits in blocks.
    /// @dev Must be harmonized with `OracleReportSanityChecker.appearedEthAmountPerDayLimit`.
    /// See docs for the `OracleReportSanityChecker.setAppearedEthAmountPerDayLimit` function).
    uint64 minDepositBlockDistance;
    /// @notice The type of withdrawal credentials for creation of validators
    uint8 withdrawalCredentialsType;
}

/// @notice The set of restrictions used in the sanity checks of the oracle report
/// @dev struct is loaded from the storage and stored in memory during the tx running
struct LimitsList {
    /// @notice The max possible exited ETH amount that might be reported
    ///     per single day.
    /// @dev Must fit into uint32 (<= 4_294_967_295)
    uint256 exitedEthAmountPerDayLimit;
    /// @notice The max possible appeared ETH amount that might be reported
    ///     per single day.
    /// @dev Must fit into uint32 (<= 4_294_967_295)
    uint256 appearedEthAmountPerDayLimit;
    /// @notice The max annual increase of the total validators' balances on the Consensus Layer
    ///     since the previous oracle report
    /// (the increase that is limited does not include fresh deposits to the Beacon Chain as well as withdrawn ether)
    ///
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 annualBalanceIncreaseBPLimit;

    /// @notice The max deviation of the provided `simulatedShareRate`
    ///     and the actual one within the currently processing oracle report
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 simulatedShareRateDeviationBPLimit;

    /// @notice The max requested to exit balance in ETH
    /// @dev Sum of all max effective balances of all requested validators should be equal or lower in one report
    uint256 maxBalanceExitRequestedPerReportInEth;

    /// @notice The max number of data list items reported to accounting oracle in extra data per single transaction
    /// @dev Must fit into uint16 (<= 65_535)
    uint256 maxItemsPerExtraDataTransaction;
    /// @notice The max number of node operators reported per extra data list item
    /// @dev Must fit into uint16 (<= 65_535)
    uint256 maxNodeOperatorsPerExtraDataItem;
    /// @notice The min time required to be passed from the creation of the request to be
    ///     finalized till the time of the oracle report
    uint256 requestTimestampMargin;
    /// @notice The positive token rebase allowed per single LidoOracle report
    /// @dev uses 1e9 precision, e.g.: 1e6 - 0.1%; 1e9 - 100%, see `setMaxPositiveTokenRebase()`
    uint256 maxPositiveTokenRebase;
    /// @notice The max allowed CL balance decrease over the CL_BALANCE_WINDOW as a fraction of the adjusted balance
    /// @dev Represented in the Basis Points (100% == 10_000). Must fit into uint16 (<= 65_535)
    uint256 maxCLBalanceDecreaseBP;
    /// @notice The maximum percent on how Second Opinion Oracle reported value could be greater
    ///     than reported by the AccountingOracle. There is an assumption that second opinion oracle CL balance
    ///     can be greater as calculated for the withdrawal credentials.
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 clBalanceOraclesErrorUpperBPLimit;
    /// @notice The max possible consolidation ETH amount that might be reported
    ///     per single day.
    /// @dev Must fit into uint32 (<= 4_294_967_295)
    uint256 consolidationEthAmountPerDayLimit;
    /// @notice Effective ETH amount attributed to a single exited validator
    ///     in the exited ETH amount per day check.
    /// @dev Stored in Wei. Must fit into uint128.
    uint256 exitedValidatorEthAmountLimit;
}

/// @dev The packed version of the LimitsList struct to be effectively persisted in storage
struct LimitsListPacked {
    uint32 exitedEthAmountPerDayLimit;
    uint32 appearedEthAmountPerDayLimit;
    uint16 annualBalanceIncreaseBPLimit;
    uint16 simulatedShareRateDeviationBPLimit;
    uint16 maxBalanceExitRequestedPerReportInEth;
    uint16 maxItemsPerExtraDataTransaction;
    uint16 maxNodeOperatorsPerExtraDataItem;
    uint32 requestTimestampMargin;
    uint64 maxPositiveTokenRebase;
    uint16 maxCLBalanceDecreaseBP;
    uint16 clBalanceOraclesErrorUpperBPLimit;
    uint32 consolidationEthAmountPerDayLimit;
    uint128 exitedValidatorEthAmountLimit;
}

struct ReportData {
    uint256 clBalance;      // CL balance in Wei
    uint256 deposits;       // Deposits for the period since the last report in Wei
    uint256 withdrawals;    // Reported withdrawalVaultBalance snapshot in Wei
}

uint256 constant MAX_BASIS_POINTS = 10_000;
uint256 constant SHARE_RATE_PRECISION_E27 = 1e27;

/// @title Sanity checks for the Lido's oracle report
/// @notice The contracts contain methods to perform sanity checks of the Lido's oracle report
///     and lever methods for granular tuning of the params of the checks
contract OracleReportSanityChecker is AccessControlEnumerable {
    using LimitsListPacker for LimitsList;
    using LimitsListUnpacker for LimitsListPacked;
    using PositiveTokenRebaseLimiter for TokenRebaseLimiterData;

    bytes32 public constant ALL_LIMITS_MANAGER_ROLE = keccak256("ALL_LIMITS_MANAGER_ROLE");
    bytes32 public constant EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE =
        keccak256("EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE");
    bytes32 public constant ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE =
        keccak256("ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE");
    bytes32 public constant SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE =
        keccak256("SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE");
    bytes32 public constant MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE =
        keccak256("MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE");
    bytes32 public constant MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE =
        keccak256("MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE");
    bytes32 public constant MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE =
        keccak256("MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE");
    bytes32 public constant REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE = keccak256("REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE");
    bytes32 public constant MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE =
        keccak256("MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE");
    bytes32 public constant SECOND_OPINION_MANAGER_ROLE = keccak256("SECOND_OPINION_MANAGER_ROLE");
    bytes32 public constant MAX_CL_BALANCE_DECREASE_MANAGER_ROLE =
        keccak256("MAX_CL_BALANCE_DECREASE_MANAGER_ROLE");
    bytes32 public constant MIGRATION_MANAGER_ROLE = keccak256("MIGRATION_MANAGER_ROLE");

    uint256 private constant DEFAULT_TIME_ELAPSED = 1 hours;
    uint256 private constant DEFAULT_CL_BALANCE = 1 gwei;
    uint256 private constant SECONDS_PER_DAY = 24 * 60 * 60;
    /// @dev Maximum withdrawals ether used for migration bootstrap, bounded by CL churn limit per report window
    uint256 private constant MAX_WITHDRAWALS_ETH_BY_CHURN_LIMIT_PER_REPORT = 57_600 ether;
    /// @dev Number of report-to-report periods in the sliding window for the CL balance decrease check
    uint256 private constant REPORTS_WINDOW = 36;

    ILidoLocator private immutable LIDO_LOCATOR;
    address private immutable ACCOUNTING_ADDRESS;

    LimitsListPacked private _limits;

    /// @dev Historical reports data
    ReportData[] public reportData;

    /// @dev The address of the second opinion oracle
    ISecondOpinionOracle public secondOpinionOracle;

    /// @param _lidoLocator address of the LidoLocator instance
    /// @param _accounting address of the Accounting instance
    /// @param _admin address to grant DEFAULT_ADMIN_ROLE of the AccessControl contract
    /// @param _limitsList initial values to be set for the limits list
    constructor(
        address _lidoLocator,
        address _accounting,
        address _admin,
        LimitsList memory _limitsList
    ) {
        if (_admin == address(0)) revert AdminCannotBeZero();
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);
        ACCOUNTING_ADDRESS = _accounting;

        _updateLimits(_limitsList);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice Return number of report data elements available on the public reportData array.
    function getReportDataCount() external view returns (uint256) {
        return reportData.length;
    }

    /// @notice returns the address of the LidoLocator
    function getLidoLocator() public view returns (address) {
        return address(LIDO_LOCATOR);
    }

    /// @notice Returns the limits list for the Lido's oracle report sanity checks
    function getOracleReportLimits() public view returns (LimitsList memory) {
        return _limits.unpack();
    }

    function getMaxCLBalanceDecreaseBP() external view returns (uint256) {
        return _limits.maxCLBalanceDecreaseBP;
    }

    /// @notice Returns max positive token rebase value with 1e9 precision:
    ///     e.g.: 1e6 - 0.1%; 1e9 - 100%
    ///     - zero value means uninitialized
    ///     - type(uint64).max means unlimited
    ///
    /// @dev Get max positive rebase allowed per single oracle report token rebase happens on total
    ///     supply adjustment, huge positive rebase can incur oracle report sandwiching.
    ///
    ///     stETH balance for the `account` defined as:
    ///         balanceOf(account) =
    ///             shares[account] * totalPooledEther / totalShares = shares[account] * shareRate
    ///
    ///     Suppose shareRate changes when oracle reports (see `handleOracleReport`)
    ///     which means that token rebase happens:
    ///
    ///         preShareRate = preTotalPooledEther() / preTotalShares()
    ///         postShareRate = postTotalPooledEther() / postTotalShares()
    ///         R = (postShareRate - preShareRate) / preShareRate
    ///
    ///         R > 0 corresponds to the relative positive rebase value (i.e., instant APR)
    ///
    /// NB: The value is not set by default (explicit initialization required),
    ///     the recommended sane values are from 0.05% to 0.1%.
    function getMaxPositiveTokenRebase() public view returns (uint256) {
        return _limits.maxPositiveTokenRebase;
    }

    /// @notice Sets the new values for the limits list and second opinion oracle
    /// @param _limitsList new limits list
    /// @param _secondOpinionOracle negative rebase oracle.
    function setOracleReportLimits(
        LimitsList calldata _limitsList,
        ISecondOpinionOracle _secondOpinionOracle
    ) external onlyRole(ALL_LIMITS_MANAGER_ROLE) {
        _updateLimits(_limitsList);
        if (_secondOpinionOracle != secondOpinionOracle) {
            secondOpinionOracle = _secondOpinionOracle;
            emit SecondOpinionOracleChanged(_secondOpinionOracle);
        }
    }

    /// @notice Sets the new value for the exitedEthAmountPerDayLimit
    /// @param _exitedEthAmountPerDayLimit new exitedEthAmountPerDayLimit value
    function setExitedEthAmountPerDayLimit(
        uint256 _exitedEthAmountPerDayLimit
    ) public onlyRole(EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.exitedEthAmountPerDayLimit = _exitedEthAmountPerDayLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the appearedEthAmountPerDayLimit
    /// @param _appearedEthAmountPerDayLimit new appearedEthAmountPerDayLimit value
    function setAppearedEthAmountPerDayLimit(
        uint256 _appearedEthAmountPerDayLimit
    ) public onlyRole(APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.appearedEthAmountPerDayLimit = _appearedEthAmountPerDayLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the consolidationEthAmountPerDayLimit
    /// @param _consolidationEthAmountPerDayLimit new consolidationEthAmountPerDayLimit value
    function setConsolidationEthAmountPerDayLimit(
        uint256 _consolidationEthAmountPerDayLimit
    ) external onlyRole(CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.consolidationEthAmountPerDayLimit = _consolidationEthAmountPerDayLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets exited validator ETH amount limiter value.
    function setExitedValidatorEthAmountLimit(
        uint256 _exitedValidatorEthAmountLimit
    ) external onlyRole(EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.exitedValidatorEthAmountLimit = _exitedValidatorEthAmountLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the annualBalanceIncreaseBPLimit
    /// @param _annualBalanceIncreaseBPLimit new annualBalanceIncreaseBPLimit value
    function setAnnualBalanceIncreaseBPLimit(
        uint256 _annualBalanceIncreaseBPLimit
    ) external onlyRole(ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.annualBalanceIncreaseBPLimit = _annualBalanceIncreaseBPLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the simulatedShareRateDeviationBPLimit
    /// @param _simulatedShareRateDeviationBPLimit new simulatedShareRateDeviationBPLimit value
    function setSimulatedShareRateDeviationBPLimit(uint256 _simulatedShareRateDeviationBPLimit)
        external
        onlyRole(SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.simulatedShareRateDeviationBPLimit = _simulatedShareRateDeviationBPLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the maxBalanceExitRequestedPerReportInEth
    /// @param _maxBalanceExitRequestedPerReportInEth new maxBalanceExitRequestedPerReportInEth value
    function setMaxBalanceExitRequestedPerReportInEth(uint16 _maxBalanceExitRequestedPerReportInEth)
        external
        onlyRole(MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxBalanceExitRequestedPerReportInEth = _maxBalanceExitRequestedPerReportInEth;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the requestTimestampMargin
    /// @param _requestTimestampMargin new requestTimestampMargin value
    function setRequestTimestampMargin(
        uint256 _requestTimestampMargin
    ) external onlyRole(REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.requestTimestampMargin = _requestTimestampMargin;
        _updateLimits(limitsList);
    }

    /// @notice Set max positive token rebase allowed per single oracle report token rebase happens
    ///     on total supply adjustment, huge positive rebase can incur oracle report sandwiching.
    ///
    /// @param _maxPositiveTokenRebase max positive token rebase value with 1e9 precision:
    ///     e.g.: 1e6 - 0.1%; 1e9 - 100%
    ///     - passing zero value is prohibited
    ///     - to allow unlimited rebases, pass max uint64, i.e.: type(uint64).max
    function setMaxPositiveTokenRebase(
        uint256 _maxPositiveTokenRebase
    ) external onlyRole(MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxPositiveTokenRebase = _maxPositiveTokenRebase;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the maxItemsPerExtraDataTransaction
    /// @param _maxItemsPerExtraDataTransaction new maxItemsPerExtraDataTransaction value
    function setMaxItemsPerExtraDataTransaction(
        uint256 _maxItemsPerExtraDataTransaction
    ) external onlyRole(MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxItemsPerExtraDataTransaction = _maxItemsPerExtraDataTransaction;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the max maxNodeOperatorsPerExtraDataItem
    /// @param _maxNodeOperatorsPerExtraDataItem new maxNodeOperatorsPerExtraDataItem value
    function setMaxNodeOperatorsPerExtraDataItem(
        uint256 _maxNodeOperatorsPerExtraDataItem
    ) external onlyRole(MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxNodeOperatorsPerExtraDataItem = _maxNodeOperatorsPerExtraDataItem;
        _updateLimits(limitsList);
    }

    /// @notice Sets the address of the second opinion oracle and clBalanceOraclesErrorUpperBPLimit value
    /// @param _secondOpinionOracle second opinion oracle.
    ///     If it's zero address — oracle is disabled.
    ///     Default value is zero address.
    /// @param _clBalanceOraclesErrorUpperBPLimit new clBalanceOraclesErrorUpperBPLimit value
    function setSecondOpinionOracleAndCLBalanceUpperMargin(
        ISecondOpinionOracle _secondOpinionOracle,
        uint256 _clBalanceOraclesErrorUpperBPLimit
    ) external onlyRole(SECOND_OPINION_MANAGER_ROLE) {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.clBalanceOraclesErrorUpperBPLimit = _clBalanceOraclesErrorUpperBPLimit;
        _updateLimits(limitsList);
        if (_secondOpinionOracle != secondOpinionOracle) {
            secondOpinionOracle = ISecondOpinionOracle(_secondOpinionOracle);
            emit SecondOpinionOracleChanged(_secondOpinionOracle);
        }
    }

    /// @notice Sets the max allowed CL balance decrease in basis points
    /// @param _maxCLBalanceDecreaseBP max CL balance decrease over the sliding window (in BP, e.g. 380 = 3.8%)
    function setMaxCLBalanceDecreaseBP(uint256 _maxCLBalanceDecreaseBP)
        external
        onlyRole(MAX_CL_BALANCE_DECREASE_MANAGER_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxCLBalanceDecreaseBP = _maxCLBalanceDecreaseBP;
        _updateLimits(limitsList);
    }

    /// @notice One-time migration: seeds initial snapshots into reportData
    ///     so that the sliding-window CL decrease check has a valid starting point.
    function migrateBaselineSnapshot() external onlyRole(MIGRATION_MANAGER_ROLE) {
        if (reportData.length != 0) revert MigrationAlreadyDone();

        address lidoAddr = LIDO_LOCATOR.lido();
        uint256 lidoVersion = IVersioned(lidoAddr).getContractVersion();
        if (lidoVersion != 4) revert UnexpectedLidoVersion(lidoVersion, 4);

        (uint256 clActive, uint256 clPending, uint256 deposits) = ILido(lidoAddr).getBalanceStats();
        uint256 clBalance = clActive + clPending;

        uint256 withdrawals = MAX_WITHDRAWALS_ETH_BY_CHURN_LIMIT_PER_REPORT;

        // The decrease formula uses baseline report B[X-k] and sums flows from reports [X-k+1..X].
        // To include migration-time deposits/withdrawals without any special-case branch in formula code:
        // 1) store pure baseline point with zero flows;
        // 2) store bootstrap flow chunk at the same CL balance right after baseline.
        _addReportData(clBalance, 0, 0);
        _addReportData(clBalance, deposits, withdrawals);

        emit BaselineSnapshotMigrated(clBalance, deposits, withdrawals);
    }

    /// @notice Returns the allowed ETH amount that might be taken from the withdrawal vault and EL
    ///     rewards vault during Lido's oracle report processing
    /// @param _preInternalEther amount of internal ETH controlled by the protocol before the report
    /// @param _preInternalShares number of internal shares before the report
    /// @param _preCLBalance sum of all Lido validators' balances on the Consensus Layer before the
    ///     current oracle report
    /// @param _postCLBalance sum of all Lido validators' balances on the Consensus Layer after the
    ///     current oracle report
    /// @param _withdrawalVaultBalance withdrawal vault balance on Execution Layer for the report calculation moment
    /// @param _elRewardsVaultBalance elRewards vault balance on Execution Layer for the report calculation moment
    /// @param _sharesRequestedToBurn shares requested to burn through Burner for the report calculation moment
    /// @param _etherToLockForWithdrawals ether to lock on withdrawals queue contract
    /// @param _newSharesToBurnForWithdrawals new shares to burn due to withdrawal request finalization
    /// @return withdrawals ETH amount allowed to be taken from the withdrawals vault
    /// @return elRewards ETH amount allowed to be taken from the EL rewards vault
    /// @return sharesFromWQToBurn amount of shares from Burner that should be burned due to WQ finalization
    /// @return sharesToBurn amount to be burnt (accounting for withdrawals finalization)
    function smoothenTokenRebase(
        uint256 _preInternalEther,
        uint256 _preInternalShares,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _etherToLockForWithdrawals,
        uint256 _newSharesToBurnForWithdrawals
    ) external view returns (uint256 withdrawals, uint256 elRewards, uint256 sharesFromWQToBurn, uint256 sharesToBurn) {
        TokenRebaseLimiterData memory tokenRebaseLimiter = PositiveTokenRebaseLimiter.initLimiterState(
            getMaxPositiveTokenRebase(),
            _preInternalEther,
            _preInternalShares
        );

        if (_postCLBalance < _preCLBalance) {
            tokenRebaseLimiter.decreaseEther(_preCLBalance - _postCLBalance);
        } else {
            tokenRebaseLimiter.increaseEther(_postCLBalance - _preCLBalance);
        }

        withdrawals = tokenRebaseLimiter.increaseEther(_withdrawalVaultBalance);
        elRewards = tokenRebaseLimiter.increaseEther(_elRewardsVaultBalance);

        // determining the shares to burn limit that would have been
        // if no withdrawals finalized during the report
        // it's used to check later the provided `simulatedShareRate` value
        uint256 simulatedSharesToBurn = Math256.min(tokenRebaseLimiter.getSharesToBurnLimit(), _sharesRequestedToBurn);

        // remove ether to lock for withdrawals from total pooled ether
        tokenRebaseLimiter.decreaseEther(_etherToLockForWithdrawals);
        // re-evaluate shares to burn after TVL was updated due to withdrawals finalization
        sharesToBurn = Math256.min(
            tokenRebaseLimiter.getSharesToBurnLimit(),
            _newSharesToBurnForWithdrawals + _sharesRequestedToBurn
        );

        sharesFromWQToBurn = sharesToBurn - simulatedSharesToBurn;
    }

    /// @notice Applies sanity checks to the accounting params of Lido's oracle report
    /// WARNING. The function has side effects and modifies the state of the contract.
    ///          It's needed to keep CL balance snapshots for the balance decrease check over a sliding window.
    /// @param _timeElapsed time elapsed since the previous oracle report
    /// @param _preCLBalance sum of all Lido validators' balances on the Consensus Layer before the
    ///     current oracle report (NB: also include the initial balance of newly appeared validators)
    /// @param _postCLBalance sum of all Lido validators' balances on the Consensus Layer after the
    ///     current oracle report
    /// @param _withdrawalVaultBalance withdrawal vault balance on Execution Layer for the report reference slot
    /// @param _elRewardsVaultBalance el rewards vault balance on Execution Layer for the report reference slot
    /// @param _sharesRequestedToBurn shares requested to burn for the report reference slot
    /// @param _deposits deposits to the Beacon Chain since the previous oracle report in Wei
    function checkAccountingOracleReport(
        uint256 _timeElapsed,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _deposits
    ) external {
        if (msg.sender != ACCOUNTING_ADDRESS) {
            revert CalledNotFromAccounting();
        }
        LimitsList memory limitsList = _limits.unpack();
        uint256 refSlot = IBaseOracle(LIDO_LOCATOR.accountingOracle()).getLastProcessingRefSlot();

        address withdrawalVault = LIDO_LOCATOR.withdrawalVault();
        // 1. Withdrawals vault reported balance
        _checkWithdrawalVaultBalance(withdrawalVault.balance, _withdrawalVaultBalance);

        address elRewardsVault = LIDO_LOCATOR.elRewardsVault();
        // 2. EL rewards vault reported balance
        _checkELRewardsVaultBalance(elRewardsVault.balance, _elRewardsVaultBalance);

        // 3. Burn requests
        _checkSharesRequestedToBurn(_sharesRequestedToBurn);

        // 4. Consensus Layer balance decrease
        _checkCLBalanceDecrease(limitsList, _preCLBalance, _postCLBalance, _withdrawalVaultBalance, _deposits, refSlot);

        // 5. Consensus Layer annual balances increase
        _checkAnnualBalancesIncrease(limitsList, _preCLBalance, _postCLBalance, _timeElapsed);

        // 6. Consensus Layer balance increase rate
        if (_postCLBalance > _preCLBalance) {
            uint256 clBalanceIncreasePerDay = _normalizePerDay(_postCLBalance - _preCLBalance, _timeElapsed);
            _checkCLBalanceIncreaseRatePerDay(limitsList, clBalanceIncreasePerDay);
        }
    }

    /// @notice Check that per-module active/pending CL balances are consistent with reported totals.
    function checkCLBalancesConsistency(
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _activeBalancesGweiByStakingModule,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _clActiveBalanceGwei,
        uint256 _clPendingBalanceGwei
    ) external pure {
        _checkCLBalancesConsistency(
            _stakingModuleIdsWithUpdatedBalance,
            _activeBalancesGweiByStakingModule,
            _pendingBalancesGweiByStakingModule,
            _clActiveBalanceGwei,
            _clPendingBalanceGwei
        );
    }

    /// @notice Check per-day module and total CL balance change rates against configured limits.
    function checkModuleAndCLBalancesChangeRates(
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _activeBalancesGweiByStakingModule,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _clActiveBalanceGwei,
        uint256 _clPendingBalanceGwei,
        uint256 _timeElapsed
    ) external view {
        _checkCLBalancesConsistency(
            _stakingModuleIdsWithUpdatedBalance,
            _activeBalancesGweiByStakingModule,
            _pendingBalancesGweiByStakingModule,
            _clActiveBalanceGwei,
            _clPendingBalanceGwei
        );

        IStakingRouter stakingRouter = IStakingRouter(LIDO_LOCATOR.stakingRouter());
        LimitsList memory limitsList = _limits.unpack();
        (uint256 moduleBalanceIncreasePerDay, uint256 moduleBalanceDecreasePerDay) = _calculateModuleBalanceChangePerDay(
            stakingRouter,
            _stakingModuleIdsWithUpdatedBalance,
            _activeBalancesGweiByStakingModule,
            _pendingBalancesGweiByStakingModule,
            _timeElapsed
        );
        (uint256 clBalanceIncreasePerDay, uint256 clBalanceDecreasePerDay, uint256 currCLValidatorsBalance) =
            _calculateCLBalanceChangePerDay(stakingRouter, _clActiveBalanceGwei, _clPendingBalanceGwei, _timeElapsed);

        uint256 slashingLimit = (currCLValidatorsBalance * limitsList.maxCLBalanceDecreaseBP) / MAX_BASIS_POINTS;
        uint256 slashingLimitPerDay = _normalizePerDay(slashingLimit, _timeElapsed);

        _checkAppearedEthAmountPerDay(limitsList, moduleBalanceIncreasePerDay);
        _checkModuleBalanceDecreaseRatePerDay(limitsList, moduleBalanceDecreasePerDay, slashingLimitPerDay);
        _checkCLBalanceIncreaseRatePerDay(limitsList, clBalanceIncreasePerDay);
        _checkCLBalanceDecreaseRatePerDay(limitsList, clBalanceDecreasePerDay, slashingLimitPerDay);
    }

    /// @notice Applies sanity checks to the number of validator exit requests supplied to ValidatorExitBusOracle
    /// @notice Checks the total balance of validator exit requests supplied per oracle report
    /// @param _maxBalanceExitRequestedPerReportInEth Total balance in ETH of all validators requested to exit in the oracle report
    function checkExitBusOracleReport(uint256 _maxBalanceExitRequestedPerReportInEth)
        external
        view
    {
        uint256 limit = _limits.unpack().maxBalanceExitRequestedPerReportInEth;
        if (_maxBalanceExitRequestedPerReportInEth > limit) {
            revert IncorrectSumOfExitBalancePerReport(_maxBalanceExitRequestedPerReportInEth);
        }
    }

    /// @notice Check exited ETH amount rate per day based on exited validators count.
    /// @param _newlyExitedValidatorsCount Number of newly exited validators since previous report.
    /// @param _timeElapsed Time elapsed in seconds since previous report.
    function checkExitedEthAmountPerDay(
        uint256 _newlyExitedValidatorsCount,
        uint256 _timeElapsed
    ) external view {
        LimitsList memory limitsList = _limits.unpack();
        uint256 exitedEthAmount = _newlyExitedValidatorsCount * limitsList.exitedValidatorEthAmountLimit;
        uint256 exitedEthAmountPerDay = _normalizePerDay(exitedEthAmount, _timeElapsed);
        _checkExitedEthAmountPerDay(limitsList, exitedEthAmountPerDay);
    }

    /// @notice Check appeared ETH amount rate per day.
    /// @param _appearedEthAmountPerDay Appeared ETH amount per day in Wei.
    function checkAppearedEthAmountPerDay(uint256 _appearedEthAmountPerDay) external view {
        _checkAppearedEthAmountPerDay(_limits.unpack(), _appearedEthAmountPerDay);
    }

    /// @notice Check module balances decrease rate per day.
    /// @param _moduleDecreaseEthAmountPerDay Module balances decrease per day in Wei.
    /// @param _slashingLimitEthAmountPerDay Slashing limit per day in Wei.
    function checkModuleBalanceDecreaseRatePerDay(
        uint256 _moduleDecreaseEthAmountPerDay,
        uint256 _slashingLimitEthAmountPerDay
    ) external view {
        _checkModuleBalanceDecreaseRatePerDay(_limits.unpack(), _moduleDecreaseEthAmountPerDay, _slashingLimitEthAmountPerDay);
    }

    /// @notice check the number of node operators reported per extra data item in the accounting oracle report.
    /// @param _itemIndex Index of item in extra data
    /// @param _nodeOperatorsCount Number of validator exit requests supplied per oracle report
    function checkNodeOperatorsPerExtraDataItemCount(uint256 _itemIndex, uint256 _nodeOperatorsCount) external view {
        uint256 limit = _limits.unpack().maxNodeOperatorsPerExtraDataItem;
        if (_nodeOperatorsCount > limit) {
            revert TooManyNodeOpsPerExtraDataItem(_itemIndex, _nodeOperatorsCount);
        }
    }

    /// @notice Check the number of extra data list items per transaction in the accounting oracle report.
    /// @param _extraDataListItemsCount Number of items per single transaction in the accounting oracle report
    function checkExtraDataItemsCountPerTransaction(uint256 _extraDataListItemsCount) external view {
        uint256 limit = _limits.unpack().maxItemsPerExtraDataTransaction;
        if (_extraDataListItemsCount > limit) {
            revert TooManyItemsPerExtraDataTransaction(limit, _extraDataListItemsCount);
        }
    }

    /// @notice Applies sanity checks to the withdrawal requests finalization
    /// @param _lastFinalizableRequestId last finalizable withdrawal request id
    /// @param _reportTimestamp timestamp when the originated oracle report was submitted
    function checkWithdrawalQueueOracleReport(
        uint256 _lastFinalizableRequestId,
        uint256 _reportTimestamp
    ) external view {
        LimitsList memory limitsList = _limits.unpack();
        address withdrawalQueue = LIDO_LOCATOR.withdrawalQueue();

        _checkLastFinalizableId(limitsList, withdrawalQueue, _lastFinalizableRequestId, _reportTimestamp);
    }

    /// @notice Applies sanity checks to the simulated share rate for withdrawal requests finalization
    /// @param _postInternalEther total pooled ether after report applied
    /// @param _postInternalShares total shares after report applied
    /// @param _etherToFinalizeWQ ether locked on withdrawal queue for the current oracle report
    /// @param _sharesToBurnForWithdrawals shares burnt due to withdrawals finalization
    /// @param _simulatedShareRate share rate provided with the oracle report (simulated via off-chain "eth_call")
    function checkSimulatedShareRate(
        uint256 _postInternalEther,
        uint256 _postInternalShares,
        uint256 _etherToFinalizeWQ,
        uint256 _sharesToBurnForWithdrawals,
        uint256 _simulatedShareRate
    ) external view {
        LimitsList memory limitsList = _limits.unpack();

        // Pretending that withdrawals were not processed
        // virtually return locked ether back to `_postTotalPooledEther`
        // virtually return burnt just finalized withdrawals shares back to `_postTotalShares`
        _checkSimulatedShareRate(
            limitsList,
            _postInternalEther + _etherToFinalizeWQ,
            _postInternalShares + _sharesToBurnForWithdrawals,
            _simulatedShareRate
        );
    }

    function _checkCLBalancesConsistency(
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _activeBalancesGweiByStakingModule,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _clActiveBalanceGwei,
        uint256 _clPendingBalanceGwei
    ) internal pure {
        uint256 modulesCount = _stakingModuleIdsWithUpdatedBalance.length;
        if (modulesCount != _activeBalancesGweiByStakingModule.length || modulesCount != _pendingBalancesGweiByStakingModule.length) {
            revert InvalidClBalancesData();
        }

        uint256 activeBalancesSum;
        uint256 pendingBalancesSum;
        for (uint256 i = 0; i < modulesCount;) {
            activeBalancesSum += _activeBalancesGweiByStakingModule[i];
            pendingBalancesSum += _pendingBalancesGweiByStakingModule[i];
            unchecked {
                ++i;
            }
        }

        if (activeBalancesSum != _clActiveBalanceGwei) {
            revert InconsistentActiveBalanceByModule(_clActiveBalanceGwei, activeBalancesSum);
        }
        if (pendingBalancesSum != _clPendingBalanceGwei) {
            revert InconsistentPendingBalanceByModule(_clPendingBalanceGwei, pendingBalancesSum);
        }
    }

    function _checkExitedEthAmountPerDay(LimitsList memory _limitsList, uint256 _exitedEthAmountPerDay) internal pure {
        uint256 exitedEthLimitWithConsolidation =
            (_limitsList.exitedEthAmountPerDayLimit + _limitsList.consolidationEthAmountPerDayLimit) * 1 ether;
        if (_exitedEthAmountPerDay > exitedEthLimitWithConsolidation) {
            revert ExitedEthAmountPerDayLimitExceeded(exitedEthLimitWithConsolidation, _exitedEthAmountPerDay);
        }
    }

    function _checkAppearedEthAmountPerDay(LimitsList memory _limitsList, uint256 _appearedEthAmountPerDay) internal pure {
        uint256 appearedEthLimitWithConsolidation =
            (_limitsList.appearedEthAmountPerDayLimit + _limitsList.consolidationEthAmountPerDayLimit) * 1 ether;
        if (_appearedEthAmountPerDay > appearedEthLimitWithConsolidation) {
            revert AppearedEthAmountPerDayLimitExceeded(appearedEthLimitWithConsolidation, _appearedEthAmountPerDay);
        }
    }

    function _checkModuleBalanceDecreaseRatePerDay(
        LimitsList memory _limitsList,
        uint256 _moduleDecreaseEthAmountPerDay,
        uint256 _slashingLimitEthAmountPerDay
    ) internal pure {
        uint256 moduleDecreaseLimitPerDay =
            (_limitsList.exitedEthAmountPerDayLimit + _limitsList.consolidationEthAmountPerDayLimit) * 1 ether +
            _slashingLimitEthAmountPerDay;
        if (_moduleDecreaseEthAmountPerDay > moduleDecreaseLimitPerDay) {
            revert ModuleBalanceDecreaseRatePerDayLimitExceeded(moduleDecreaseLimitPerDay, _moduleDecreaseEthAmountPerDay);
        }
    }

    function _checkCLBalanceIncreaseRatePerDay(
        LimitsList memory _limitsList,
        uint256 _clBalanceIncreaseEthAmountPerDay
    ) internal pure {
        uint256 clBalanceIncreaseLimitPerDay = _limitsList.appearedEthAmountPerDayLimit * 1 ether;
        if (_clBalanceIncreaseEthAmountPerDay > clBalanceIncreaseLimitPerDay) {
            revert CLBalanceIncreaseRatePerDayLimitExceeded(
                clBalanceIncreaseLimitPerDay,
                _clBalanceIncreaseEthAmountPerDay
            );
        }
    }

    function _checkCLBalanceDecreaseRatePerDay(
        LimitsList memory _limitsList,
        uint256 _clBalanceDecreaseEthAmountPerDay,
        uint256 _slashingLimitEthAmountPerDay
    ) internal pure {
        uint256 clBalanceDecreaseLimitPerDay = _limitsList.exitedEthAmountPerDayLimit * 1 ether + _slashingLimitEthAmountPerDay;
        if (_clBalanceDecreaseEthAmountPerDay > clBalanceDecreaseLimitPerDay) {
            revert CLBalanceDecreaseRatePerDayLimitExceeded(
                clBalanceDecreaseLimitPerDay,
                _clBalanceDecreaseEthAmountPerDay
            );
        }
    }

    function _calculateModuleBalanceChangePerDay(
        IStakingRouter _stakingRouter,
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _activeBalancesGweiByStakingModule,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _timeElapsed
    ) internal view returns (uint256 moduleBalanceIncreasePerDay, uint256 moduleBalanceDecreasePerDay) {
        uint256 moduleBalanceIncrease;
        uint256 moduleBalanceDecrease;
        for (uint256 i = 0; i < _stakingModuleIdsWithUpdatedBalance.length;) {
            uint256 previousModuleBalance = _stakingRouter.getStakingModuleBalance(_stakingModuleIdsWithUpdatedBalance[i]);
            uint256 currentModuleBalance =
                (_activeBalancesGweiByStakingModule[i] + _pendingBalancesGweiByStakingModule[i]) * 1 gwei;
            if (currentModuleBalance >= previousModuleBalance) {
                moduleBalanceIncrease += currentModuleBalance - previousModuleBalance;
            } else {
                moduleBalanceDecrease += previousModuleBalance - currentModuleBalance;
            }
            unchecked {
                ++i;
            }
        }

        moduleBalanceIncreasePerDay = _normalizePerDay(moduleBalanceIncrease, _timeElapsed);
        moduleBalanceDecreasePerDay = _normalizePerDay(moduleBalanceDecrease, _timeElapsed);
    }

    function _calculateCLBalanceChangePerDay(
        IStakingRouter _stakingRouter,
        uint256 _clActiveBalanceGwei,
        uint256 _clPendingBalanceGwei,
        uint256 _timeElapsed
    ) internal view returns (uint256 clBalanceIncreasePerDay, uint256 clBalanceDecreasePerDay, uint256 currCLValidatorsBalance) {
        uint256 previousCLValidatorsBalance = _stakingRouter.getTotalStakingModulesBalance();
        currCLValidatorsBalance = (_clActiveBalanceGwei + _clPendingBalanceGwei) * 1 gwei;
        uint256 clBalanceIncrease;
        uint256 clBalanceDecrease;
        if (currCLValidatorsBalance >= previousCLValidatorsBalance) {
            clBalanceIncrease = currCLValidatorsBalance - previousCLValidatorsBalance;
        } else {
            clBalanceDecrease = previousCLValidatorsBalance - currCLValidatorsBalance;
        }
        clBalanceIncreasePerDay = _normalizePerDay(clBalanceIncrease, _timeElapsed);
        clBalanceDecreasePerDay = _normalizePerDay(clBalanceDecrease, _timeElapsed);
    }

    function _normalizePerDay(uint256 _amount, uint256 _timeElapsed) internal pure returns (uint256) {
        if (_timeElapsed == 0) {
            return _amount * SECONDS_PER_DAY;
        }
        return (_amount * SECONDS_PER_DAY) / _timeElapsed;
    }

    function _checkWithdrawalVaultBalance(
        uint256 _actualWithdrawalVaultBalance,
        uint256 _reportedWithdrawalVaultBalance
    ) internal pure {
        if (_reportedWithdrawalVaultBalance > _actualWithdrawalVaultBalance) {
            revert IncorrectWithdrawalsVaultBalance(_actualWithdrawalVaultBalance);
        }
    }

    function _checkELRewardsVaultBalance(
        uint256 _actualELRewardsVaultBalance,
        uint256 _reportedELRewardsVaultBalance
    ) internal pure {
        if (_reportedELRewardsVaultBalance > _actualELRewardsVaultBalance) {
            revert IncorrectELRewardsVaultBalance(_actualELRewardsVaultBalance);
        }
    }

    function _checkSharesRequestedToBurn(uint256 _sharesRequestedToBurn) internal view {
        (uint256 coverShares, uint256 nonCoverShares) = IBurner(LIDO_LOCATOR.burner()).getSharesRequestedToBurn();
        uint256 actualSharesToBurn = coverShares + nonCoverShares;
        if (_sharesRequestedToBurn > actualSharesToBurn) {
            revert IncorrectSharesRequestedToBurn(actualSharesToBurn);
        }
    }

    function _addReportData(uint256 _clBalance, uint256 _deposits, uint256 _withdrawals) internal {
        reportData.push(ReportData(_clBalance, _deposits, _withdrawals));
    }

    function _checkCLBalanceDecrease(
        LimitsList memory _limitsList,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _deposits,
        uint256 _refSlot
    ) internal {
        // Store current report point together with report-level flow terms:
        // - deposits are reported since previous oracle report
        // - withdrawals use reported withdrawalVaultBalance snapshot
        _addReportData(_postCLBalance, _deposits, _withdrawalVaultBalance);

        // If the CL balance didn't decrease accounting for withdrawals, skip the window check
        if (_preCLBalance <= _postCLBalance + _withdrawalVaultBalance) return;

        uint256 len = reportData.length;
        // Need at least two snapshots to build a window: baseline B[X-k] and current point B[X].
        // With migration we seed them upfront (baseline + bootstrap flow chunk), so checks work immediately.
        // Without migration this still works, but the very first report cannot be checked and pre-deploy
        // state is not part of the window until enough post-deploy snapshots are accumulated.
        if (len < 2) return;

        (uint256 actualDiff, uint256 maxDiff) = _calcCLBalanceDecrease(_limitsList.maxCLBalanceDecreaseBP, _postCLBalance, len);

        if (actualDiff == 0) return;

        if (actualDiff > maxDiff) {
            if (address(secondOpinionOracle) == address(0)) {
                revert IncorrectCLBalanceDecrease(actualDiff, maxDiff);
            }
            _askSecondOpinion(_refSlot, _postCLBalance, _withdrawalVaultBalance, _limitsList);
            return;
        }

        emit NegativeCLRebaseAccepted(_refSlot, _postCLBalance, actualDiff, maxDiff);
    }

    function _calcCLBalanceDecrease(
        uint256 _maxCLBalanceDecreaseBP,
        uint256 _postCLBalance,
        uint256 _len
    ) internal view returns (uint256 actualDiff, uint256 maxDiff) {
        // Window formula:
        // X  = latest report index
        // k  = min(REPORTS_WINDOW, X)
        // X-k is the baseline report
        // actualDiff   = B[X-k] - B[X]
        // adjustedBase = B[X-k] + sum_{i = X-k+1..X}(D[i] - W[i])
        // maxDiff      = adjustedBase * limitBP / 10_000
        //
        // ReportData semantics:
        // - clBalance is a point value at report i
        // - deposits correspond to period flow for transition (i-1 -> i)
        // - withdrawals are withdrawalVaultBalance snapshots reported at report i
        uint256 latestReportDataIndex = _len - 1;
        uint256 windowTransitionsCount =
            latestReportDataIndex > REPORTS_WINDOW ? REPORTS_WINDOW : latestReportDataIndex;
        uint256 baselineReportDataIndex = latestReportDataIndex - windowTransitionsCount;

        uint256 baselineBalance = reportData[baselineReportDataIndex].clBalance;
        if (_postCLBalance >= baselineBalance) return (0, 0);

        actualDiff = baselineBalance - _postCLBalance;

        uint256 firstReportDataIndexWithinWindowFlowRange = baselineReportDataIndex + 1;
        uint256 totalDeposits;
        uint256 totalReportedWithdrawalVaultBalances;
        for (
            uint256 reportDataIndex = firstReportDataIndexWithinWindowFlowRange;
            reportDataIndex <= latestReportDataIndex;
            ++reportDataIndex
        ) {
            totalDeposits += reportData[reportDataIndex].deposits;
            totalReportedWithdrawalVaultBalances += reportData[reportDataIndex].withdrawals;
        }

        uint256 baselineWithDeposits = baselineBalance + totalDeposits;
        if (baselineWithDeposits < totalReportedWithdrawalVaultBalances) {
            revert IncorrectCLBalanceDecreaseWindowData(
                baselineBalance,
                totalDeposits,
                totalReportedWithdrawalVaultBalances
            );
        }

        uint256 adjustedBase = baselineWithDeposits - totalReportedWithdrawalVaultBalances;
        maxDiff = (adjustedBase * _maxCLBalanceDecreaseBP) / MAX_BASIS_POINTS;
    }

    function _askSecondOpinion(
        uint256 _refSlot,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        LimitsList memory _limitsList
    ) internal {
        (bool success, uint256 clOracleBalanceGwei, uint256 oracleWithdrawalVaultBalanceWei, , ) = secondOpinionOracle
            .getReport(_refSlot);

        if (success) {
            uint256 clBalanceWei = clOracleBalanceGwei * 1 gwei;
            if (clBalanceWei < _postCLBalance) {
                revert NegativeRebaseFailedCLBalanceMismatch(
                    _postCLBalance,
                    clBalanceWei,
                    _limitsList.clBalanceOraclesErrorUpperBPLimit
                );
            }
            if (
                MAX_BASIS_POINTS * (clBalanceWei - _postCLBalance) >
                _limitsList.clBalanceOraclesErrorUpperBPLimit * clBalanceWei
            ) {
                revert NegativeRebaseFailedCLBalanceMismatch(
                    _postCLBalance,
                    clBalanceWei,
                    _limitsList.clBalanceOraclesErrorUpperBPLimit
                );
            }
            if (oracleWithdrawalVaultBalanceWei != _withdrawalVaultBalance) {
                revert NegativeRebaseFailedWithdrawalVaultBalanceMismatch(
                    _withdrawalVaultBalance,
                    oracleWithdrawalVaultBalanceWei
                );
            }
            emit NegativeCLRebaseConfirmed(_refSlot, _postCLBalance, _withdrawalVaultBalance);
        } else {
            revert NegativeRebaseFailedSecondOpinionReportIsNotReady();
        }
    }

    function _checkAnnualBalancesIncrease(
        LimitsList memory _limitsList,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _timeElapsed
    ) internal pure {
        // allow zero values for scratch deploy
        // NB: annual increase have to be large enough for scratch deploy
        if (_preCLBalance == 0) {
            _preCLBalance = DEFAULT_CL_BALANCE;
        }

        if (_preCLBalance >= _postCLBalance) return;

        if (_timeElapsed == 0) {
            _timeElapsed = DEFAULT_TIME_ELAPSED;
        }

        uint256 balanceIncrease = _postCLBalance - _preCLBalance;
        uint256 annualBalanceIncrease = ((365 days * MAX_BASIS_POINTS * balanceIncrease) / _preCLBalance) /
            _timeElapsed;

        if (annualBalanceIncrease > _limitsList.annualBalanceIncreaseBPLimit) {
            revert IncorrectCLBalanceIncrease(annualBalanceIncrease);
        }
    }



    function _checkLastFinalizableId(
        LimitsList memory _limitsList,
        address _withdrawalQueue,
        uint256 _lastFinalizableId,
        uint256 _reportTimestamp
    ) internal view {
        uint256[] memory requestIds = new uint256[](1);
        requestIds[0] = _lastFinalizableId;

        IWithdrawalQueue.WithdrawalRequestStatus[] memory statuses = IWithdrawalQueue(_withdrawalQueue)
            .getWithdrawalStatus(requestIds);
        if (_reportTimestamp < statuses[0].timestamp + _limitsList.requestTimestampMargin)
            revert IncorrectRequestFinalization(statuses[0].timestamp);
    }

    function _checkSimulatedShareRate(
        LimitsList memory _limitsList,
        uint256 _noWithdrawalsPostInternalEther,
        uint256 _noWithdrawalsPostInternalShares,
        uint256 _simulatedShareRate
    ) internal pure {
        assert(_noWithdrawalsPostInternalEther != 0);
        uint256 actualShareRate = (
            _noWithdrawalsPostInternalEther * SHARE_RATE_PRECISION_E27
        ) / _noWithdrawalsPostInternalShares;

        // the simulated share rate can be either higher or lower than the actual one
        // in case of new user-submitted ether & minted `stETH` between the oracle reference slot
        // and the actual report delivery slot
        //
        // it happens because the oracle daemon snapshots rewards or losses at the reference slot,
        // and then calculates simulated share rate, but if new ether was submitted together with minting new `stETH`
        // after the reference slot passed, the oracle daemon still submits the same amount of rewards or losses,
        // which now is applicable to more 'shareholders', lowering the impact per a single share
        // (i.e, changing the actual share rate)
        //
        // simulated share rate ≤ actual share rate can be for a negative token rebase
        // simulated share rate ≥ actual share rate can be for a positive token rebase
        //
        // Given that:
        // 1) CL one-off balance decrease ≤ token rebase ≤ max positive token rebase
        // 2) user-submitted ether & minted `stETH` don't exceed the current staking rate limit
        // (see Lido.getCurrentStakeLimit())
        //
        // can conclude that `simulatedShareRateDeviationBPLimit` (L) should be set as follows:
        // L = (2 * SRL) * max(CLD, MPR),
        // where:
        // - CLD is consensus layer one-off balance decrease (as BP),
        // - MPR is max positive token rebase (as BP),
        // - SRL is staking rate limit normalized by TVL (`maxStakeLimit / totalPooledEther`)
        //   totalPooledEther should be chosen as a reasonable lower bound of the protocol TVL
        //
        uint256 simulatedShareDiff = Math256.absDiff(actualShareRate, _simulatedShareRate);
        uint256 simulatedShareDeviation = (MAX_BASIS_POINTS * simulatedShareDiff) / actualShareRate;

        if (simulatedShareDeviation > _limitsList.simulatedShareRateDeviationBPLimit) {
            revert IncorrectSimulatedShareRate(_simulatedShareRate, actualShareRate);
        }
    }

    function _updateLimits(LimitsList memory _newLimitsList) internal {
        LimitsList memory _oldLimitsList = _limits.unpack();
        if (_oldLimitsList.exitedEthAmountPerDayLimit != _newLimitsList.exitedEthAmountPerDayLimit) {
            _checkLimitValue(_newLimitsList.exitedEthAmountPerDayLimit, 0, type(uint32).max);
            emit ExitedEthAmountPerDayLimitSet(_newLimitsList.exitedEthAmountPerDayLimit);
        }
        if (_oldLimitsList.appearedEthAmountPerDayLimit != _newLimitsList.appearedEthAmountPerDayLimit) {
            _checkLimitValue(_newLimitsList.appearedEthAmountPerDayLimit, 0, type(uint32).max);
            emit AppearedEthAmountPerDayLimitSet(_newLimitsList.appearedEthAmountPerDayLimit);
        }
        if (_oldLimitsList.consolidationEthAmountPerDayLimit != _newLimitsList.consolidationEthAmountPerDayLimit) {
            _checkLimitValue(_newLimitsList.consolidationEthAmountPerDayLimit, 0, type(uint32).max);
            emit ConsolidationEthAmountPerDayLimitSet(_newLimitsList.consolidationEthAmountPerDayLimit);
        }
        if (_oldLimitsList.exitedValidatorEthAmountLimit != _newLimitsList.exitedValidatorEthAmountLimit) {
            _checkLimitValue(_newLimitsList.exitedValidatorEthAmountLimit, 1, type(uint128).max);
            emit ExitedValidatorEthAmountLimitSet(_newLimitsList.exitedValidatorEthAmountLimit);
        }
        if (_oldLimitsList.annualBalanceIncreaseBPLimit != _newLimitsList.annualBalanceIncreaseBPLimit) {
            _checkLimitValue(_newLimitsList.annualBalanceIncreaseBPLimit, 0, MAX_BASIS_POINTS);
            emit AnnualBalanceIncreaseBPLimitSet(_newLimitsList.annualBalanceIncreaseBPLimit);
        }
        if (_oldLimitsList.simulatedShareRateDeviationBPLimit != _newLimitsList.simulatedShareRateDeviationBPLimit) {
            _checkLimitValue(_newLimitsList.simulatedShareRateDeviationBPLimit, 0, MAX_BASIS_POINTS);
            emit SimulatedShareRateDeviationBPLimitSet(_newLimitsList.simulatedShareRateDeviationBPLimit);
        }
        if (_oldLimitsList.maxBalanceExitRequestedPerReportInEth != _newLimitsList.maxBalanceExitRequestedPerReportInEth) {
            _checkLimitValue(_newLimitsList.maxBalanceExitRequestedPerReportInEth, 0, type(uint16).max);
            emit MaxBalanceExitRequestedPerReportInEthSet(uint16(_newLimitsList.maxBalanceExitRequestedPerReportInEth));
        }
        if (_oldLimitsList.maxItemsPerExtraDataTransaction != _newLimitsList.maxItemsPerExtraDataTransaction) {
            _checkLimitValue(_newLimitsList.maxItemsPerExtraDataTransaction, 0, type(uint16).max);
            emit MaxItemsPerExtraDataTransactionSet(_newLimitsList.maxItemsPerExtraDataTransaction);
        }
        if (_oldLimitsList.maxNodeOperatorsPerExtraDataItem != _newLimitsList.maxNodeOperatorsPerExtraDataItem) {
            _checkLimitValue(_newLimitsList.maxNodeOperatorsPerExtraDataItem, 0, type(uint16).max);
            emit MaxNodeOperatorsPerExtraDataItemSet(_newLimitsList.maxNodeOperatorsPerExtraDataItem);
        }
        if (_oldLimitsList.requestTimestampMargin != _newLimitsList.requestTimestampMargin) {
            _checkLimitValue(_newLimitsList.requestTimestampMargin, 0, type(uint32).max);
            emit RequestTimestampMarginSet(_newLimitsList.requestTimestampMargin);
        }
        if (_oldLimitsList.maxPositiveTokenRebase != _newLimitsList.maxPositiveTokenRebase) {
            _checkLimitValue(_newLimitsList.maxPositiveTokenRebase, 1, type(uint64).max);
            emit MaxPositiveTokenRebaseSet(_newLimitsList.maxPositiveTokenRebase);
        }
        if (_oldLimitsList.maxCLBalanceDecreaseBP != _newLimitsList.maxCLBalanceDecreaseBP) {
            _checkLimitValue(_newLimitsList.maxCLBalanceDecreaseBP, 0, MAX_BASIS_POINTS);
            emit MaxCLBalanceDecreaseBPSet(_newLimitsList.maxCLBalanceDecreaseBP);
        }
        if (_oldLimitsList.clBalanceOraclesErrorUpperBPLimit != _newLimitsList.clBalanceOraclesErrorUpperBPLimit) {
            _checkLimitValue(_newLimitsList.clBalanceOraclesErrorUpperBPLimit, 0, MAX_BASIS_POINTS);
            emit CLBalanceOraclesErrorUpperBPLimitSet(_newLimitsList.clBalanceOraclesErrorUpperBPLimit);
        }
        _limits = _newLimitsList.pack();
    }

    function _checkLimitValue(uint256 _value, uint256 _minAllowedValue, uint256 _maxAllowedValue) internal pure {
        if (_value > _maxAllowedValue || _value < _minAllowedValue) {
            revert IncorrectLimitValue(_value, _minAllowedValue, _maxAllowedValue);
        }
    }

    event ExitedEthAmountPerDayLimitSet(uint256 exitedEthAmountPerDayLimit);
    event AppearedEthAmountPerDayLimitSet(uint256 appearedEthAmountPerDayLimit);
    event ConsolidationEthAmountPerDayLimitSet(uint256 consolidationEthAmountPerDayLimit);
    event ExitedValidatorEthAmountLimitSet(uint256 exitedValidatorEthAmountLimit);
    event SecondOpinionOracleChanged(ISecondOpinionOracle indexed secondOpinionOracle);
    event AnnualBalanceIncreaseBPLimitSet(uint256 annualBalanceIncreaseBPLimit);
    event SimulatedShareRateDeviationBPLimitSet(uint256 simulatedShareRateDeviationBPLimit);
    event MaxPositiveTokenRebaseSet(uint256 maxPositiveTokenRebase);
    event MaxBalanceExitRequestedPerReportInEthSet(uint256 maxBalanceExitRequestedPerReportInEth);
    event MaxItemsPerExtraDataTransactionSet(uint256 maxItemsPerExtraDataTransaction);
    event MaxNodeOperatorsPerExtraDataItemSet(uint256 maxNodeOperatorsPerExtraDataItem);
    event RequestTimestampMarginSet(uint256 requestTimestampMargin);
    event MaxCLBalanceDecreaseBPSet(uint256 maxCLBalanceDecreaseBP);
    event CLBalanceOraclesErrorUpperBPLimitSet(uint256 clBalanceOraclesErrorUpperBPLimit);
    event NegativeCLRebaseConfirmed(uint256 refSlot, uint256 clBalanceWei, uint256 withdrawalVaultBalance);
    event NegativeCLRebaseAccepted(
        uint256 refSlot,
        uint256 clTotalBalance,
        uint256 clBalanceDecrease,
        uint256 maxAllowedDecrease
    );

    error IncorrectLimitValue(uint256 value, uint256 minAllowedValue, uint256 maxAllowedValue);
    error IncorrectWithdrawalsVaultBalance(uint256 actualWithdrawalVaultBalance);
    error IncorrectELRewardsVaultBalance(uint256 actualELRewardsVaultBalance);
    error IncorrectSharesRequestedToBurn(uint256 actualSharesToBurn);
    error IncorrectCLBalanceIncrease(uint256 annualBalanceDiff);
    error InvalidClBalancesData();
    error InconsistentActiveBalanceByModule(uint256 expected, uint256 actual);
    error InconsistentPendingBalanceByModule(uint256 expected, uint256 actual);
    error AppearedEthAmountPerDayLimitExceeded(uint256 limitPerDay, uint256 appearedPerDay);
    error ModuleBalanceDecreaseRatePerDayLimitExceeded(uint256 limitPerDay, uint256 decreasePerDay);
    error CLBalanceIncreaseRatePerDayLimitExceeded(uint256 limitPerDay, uint256 increasePerDay);
    error CLBalanceDecreaseRatePerDayLimitExceeded(uint256 limitPerDay, uint256 decreasePerDay);
    error IncorrectSumOfExitBalancePerReport(uint256 maxBalanceSum);
    error IncorrectRequestFinalization(uint256 requestCreationBlock);
    error IncorrectSimulatedShareRate(uint256 simulatedShareRate, uint256 actualShareRate);
    error TooManyItemsPerExtraDataTransaction(uint256 maxItemsCount, uint256 receivedItemsCount);
    error ExitedEthAmountPerDayLimitExceeded(uint256 limitPerDay, uint256 exitedPerDay);
    error TooManyNodeOpsPerExtraDataItem(uint256 itemIndex, uint256 nodeOpsCount);
    error AdminCannotBeZero();

    error IncorrectCLBalanceDecrease(uint256 negativeCLRebaseSum, uint256 maxNegativeCLRebaseSum);
    error NegativeRebaseFailedCLBalanceMismatch(uint256 reportedValue, uint256 provedValue, uint256 limitBP);
    error NegativeRebaseFailedWithdrawalVaultBalanceMismatch(uint256 reportedValue, uint256 provedValue);
    error NegativeRebaseFailedSecondOpinionReportIsNotReady();
    error CalledNotFromAccounting();
    error IncorrectCLBalanceDecreaseWindowData(
        uint256 baselineBalance,
        uint256 totalDeposits,
        uint256 totalReportedWithdrawalVaultBalances
    );
    error MigrationAlreadyDone();
    error UnexpectedLidoVersion(uint256 actual, uint256 expected);

    event BaselineSnapshotMigrated(uint256 clBalance, uint256 deposits, uint256 withdrawals);
}

library LimitsListPacker {
    error BasisPointsOverflow(uint256 value, uint256 maxValue);

    function pack(LimitsList memory _limitsList) internal pure returns (LimitsListPacked memory res) {
        res.exitedEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.exitedEthAmountPerDayLimit);
        res.appearedEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.appearedEthAmountPerDayLimit);
        res.consolidationEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.consolidationEthAmountPerDayLimit);
        res.annualBalanceIncreaseBPLimit = _toBasisPoints(_limitsList.annualBalanceIncreaseBPLimit);
        res.simulatedShareRateDeviationBPLimit = _toBasisPoints(_limitsList.simulatedShareRateDeviationBPLimit);
        res.requestTimestampMargin = SafeCast.toUint32(_limitsList.requestTimestampMargin);
        res.maxPositiveTokenRebase = SafeCast.toUint64(_limitsList.maxPositiveTokenRebase);
        res.maxBalanceExitRequestedPerReportInEth = SafeCast.toUint16(_limitsList.maxBalanceExitRequestedPerReportInEth);
        res.maxItemsPerExtraDataTransaction = SafeCast.toUint16(_limitsList.maxItemsPerExtraDataTransaction);
        res.maxNodeOperatorsPerExtraDataItem = SafeCast.toUint16(_limitsList.maxNodeOperatorsPerExtraDataItem);
        res.maxCLBalanceDecreaseBP = _toBasisPoints(_limitsList.maxCLBalanceDecreaseBP);
        res.clBalanceOraclesErrorUpperBPLimit = _toBasisPoints(_limitsList.clBalanceOraclesErrorUpperBPLimit);
        res.exitedValidatorEthAmountLimit = SafeCast.toUint128(_limitsList.exitedValidatorEthAmountLimit);
    }

    function _toBasisPoints(uint256 _value) private pure returns (uint16) {
        if (_value > MAX_BASIS_POINTS) {
            revert BasisPointsOverflow(_value, MAX_BASIS_POINTS);
        }
        return uint16(_value);
    }
}

library LimitsListUnpacker {
    function unpack(LimitsListPacked memory _limitsList) internal pure returns (LimitsList memory res) {
        res.exitedEthAmountPerDayLimit = _limitsList.exitedEthAmountPerDayLimit;
        res.appearedEthAmountPerDayLimit = _limitsList.appearedEthAmountPerDayLimit;
        res.consolidationEthAmountPerDayLimit = _limitsList.consolidationEthAmountPerDayLimit;
        res.annualBalanceIncreaseBPLimit = _limitsList.annualBalanceIncreaseBPLimit;
        res.simulatedShareRateDeviationBPLimit = _limitsList.simulatedShareRateDeviationBPLimit;
        res.requestTimestampMargin = _limitsList.requestTimestampMargin;
        res.maxPositiveTokenRebase = _limitsList.maxPositiveTokenRebase;
        res.maxBalanceExitRequestedPerReportInEth = _limitsList.maxBalanceExitRequestedPerReportInEth;
        res.maxItemsPerExtraDataTransaction = _limitsList.maxItemsPerExtraDataTransaction;
        res.maxNodeOperatorsPerExtraDataItem = _limitsList.maxNodeOperatorsPerExtraDataItem;
        res.maxCLBalanceDecreaseBP = _limitsList.maxCLBalanceDecreaseBP;
        res.clBalanceOraclesErrorUpperBPLimit = _limitsList.clBalanceOraclesErrorUpperBPLimit;
        res.exitedValidatorEthAmountLimit = _limitsList.exitedValidatorEthAmountLimit;
    }
}
