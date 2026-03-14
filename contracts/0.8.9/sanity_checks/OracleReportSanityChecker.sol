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
    function getStakingModuleStateAccounting(uint256 _stakingModuleId)
        external
        view
        returns (
            uint64 validatorsBalanceGwei,
            uint64 pendingBalanceGwei,
            uint64 exitedValidatorsCount
        );
    function getStakingModuleBalance(uint256 moduleId) external view returns (uint256);
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
    /// @notice WC 0x01 max effective balance equivalent weight in ETH
    /// @dev Must fit into uint16 and be non-zero
    uint256 maxEffectiveBalanceWeightWCType01;
    /// @notice WC 0x02 max effective balance equivalent weight in ETH
    /// @dev Must fit into uint16 and be non-zero
    uint256 maxEffectiveBalanceWeightWCType02;

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
    /// @dev Stored in whole ETH units. Must fit into uint16.
    uint256 exitedValidatorEthAmountLimit;
}

/// @dev The packed accounting/rebase limits persisted in a single storage slot
struct AccountingCoreLimitsPacked {
    uint32 exitedEthAmountPerDayLimit;
    uint32 appearedEthAmountPerDayLimit;
    uint32 consolidationEthAmountPerDayLimit;
    uint16 annualBalanceIncreaseBPLimit;
    uint16 simulatedShareRateDeviationBPLimit;
    uint64 maxPositiveTokenRebase;
    uint16 maxCLBalanceDecreaseBP;
    uint16 clBalanceOraclesErrorUpperBPLimit;
    uint16 exitedValidatorEthAmountLimit;
}

/// @dev The packed operational limits persisted in a single storage slot
struct OperationalLimitsPacked {
    uint16 maxBalanceExitRequestedPerReportInEth;
    uint16 maxEffectiveBalanceWeightWCType01;
    uint16 maxEffectiveBalanceWeightWCType02;
    uint16 maxItemsPerExtraDataTransaction;
    uint16 maxNodeOperatorsPerExtraDataItem;
    uint32 requestTimestampMargin;
}

struct ReportData {
    uint64 timestamp;       // Logical report timestamp in seconds
    uint128 clBalance;      // Total CL balance (validators + pending) in Wei
    uint128 deposits;       // Deposits for the period since the last report in Wei
    uint128 clWithdrawals;  // Actual ETH moved from CL to withdrawal vault this period
}

struct CLBalanceDecreaseCheckParams {
    uint256 maxCLBalanceDecreaseBP;
    uint256 clBalanceOraclesErrorUpperBPLimit;
    uint256 preCLBalance;
    uint256 postCLBalance;
    uint256 withdrawalVaultBalance;
    uint256 withdrawalsVaultTransfer;
    uint256 deposits;
    uint256 timeElapsed;
}

uint256 constant MAX_BASIS_POINTS = 10_000;
uint256 constant SHARE_RATE_PRECISION_E27 = 1e27;

/// @title Sanity checks for the Lido's oracle report
/// @notice The contracts contain methods to perform sanity checks of the Lido's oracle report
///     and lever methods for granular tuning of the params of the checks
contract OracleReportSanityChecker is AccessControlEnumerable {
    using LimitsListPacker for LimitsList;
    using LimitsListUnpacker for AccountingCoreLimitsPacked;
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
    bytes32 public constant MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE =
        keccak256("MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE");
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
    uint256 private constant ANNUAL_BALANCE_INCREASE_DENOMINATOR = 365 days * MAX_BASIS_POINTS;
    /// @dev Maximum withdrawals ether used for migration bootstrap, bounded by CL churn limit per report window
    uint256 private constant MAX_WITHDRAWALS_ETH_BY_CHURN_LIMIT_PER_REPORT = 57_600 ether;
    /// @dev Time window for the CL balance decrease check
    uint256 private constant CL_BALANCE_WINDOW = 36 days;

    ILidoLocator private immutable LIDO_LOCATOR;
    address private immutable ACCOUNTING_ADDRESS;

    AccountingCoreLimitsPacked private _accountingCoreLimits;
    OperationalLimitsPacked private _operationalLimits;

    /// @dev Historical reports data
    ReportData[] public reportData;

    /// @dev The address of the second opinion oracle
    ISecondOpinionOracle public secondOpinionOracle;

    /// @dev Withdrawal vault balance after the last report's transfer was applied.
    ///      Used to compute actual CL withdrawals: clWithdrawals = WVB_current - _lastVaultBalanceAfterTransfer
    uint256 private _lastVaultBalanceAfterTransfer;

    /// @dev Logical timestamp of the latest stored report snapshot.
    ///      It is advanced by `_timeElapsed` on each accounting report.
    uint256 private _lastReportTimestamp;

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
        return _accountingCoreLimits.unpack(_operationalLimits);
    }

    function getMaxCLBalanceDecreaseBP() external view returns (uint256) {
        return _accountingCoreLimits.maxCLBalanceDecreaseBP;
    }

    function getMaxEffectiveBalanceWeightWCType01() external view returns (uint256) {
        return _operationalLimits.maxEffectiveBalanceWeightWCType01;
    }

    function getMaxEffectiveBalanceWeightWCType02() external view returns (uint256) {
        return _operationalLimits.maxEffectiveBalanceWeightWCType02;
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
        return _accountingCoreLimits.maxPositiveTokenRebase;
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
        _checkLimitValue(_exitedEthAmountPerDayLimit, 0, type(uint32).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.exitedEthAmountPerDayLimit = SafeCast.toUint32(_exitedEthAmountPerDayLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the appearedEthAmountPerDayLimit
    /// @param _appearedEthAmountPerDayLimit new appearedEthAmountPerDayLimit value
    function setAppearedEthAmountPerDayLimit(
        uint256 _appearedEthAmountPerDayLimit
    ) public onlyRole(APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE) {
        _checkLimitValue(_appearedEthAmountPerDayLimit, 0, type(uint32).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.appearedEthAmountPerDayLimit = SafeCast.toUint32(_appearedEthAmountPerDayLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the consolidationEthAmountPerDayLimit
    /// @param _consolidationEthAmountPerDayLimit new consolidationEthAmountPerDayLimit value
    function setConsolidationEthAmountPerDayLimit(
        uint256 _consolidationEthAmountPerDayLimit
    ) external onlyRole(CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE) {
        _checkLimitValue(_consolidationEthAmountPerDayLimit, 0, type(uint32).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.consolidationEthAmountPerDayLimit = SafeCast.toUint32(_consolidationEthAmountPerDayLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets exited validator ETH amount limiter value.
    function setExitedValidatorEthAmountLimit(
        uint256 _exitedValidatorEthAmountLimit
    ) external onlyRole(EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE) {
        _checkLimitValue(_exitedValidatorEthAmountLimit, 1, type(uint16).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.exitedValidatorEthAmountLimit = SafeCast.toUint16(_exitedValidatorEthAmountLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the annualBalanceIncreaseBPLimit
    /// @param _annualBalanceIncreaseBPLimit new annualBalanceIncreaseBPLimit value
    function setAnnualBalanceIncreaseBPLimit(
        uint256 _annualBalanceIncreaseBPLimit
    ) external onlyRole(ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE) {
        _checkLimitValue(_annualBalanceIncreaseBPLimit, 0, MAX_BASIS_POINTS);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.annualBalanceIncreaseBPLimit = LimitsListPacker.toBasisPoints(_annualBalanceIncreaseBPLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the simulatedShareRateDeviationBPLimit
    /// @param _simulatedShareRateDeviationBPLimit new simulatedShareRateDeviationBPLimit value
    function setSimulatedShareRateDeviationBPLimit(uint256 _simulatedShareRateDeviationBPLimit)
        external
        onlyRole(SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE)
    {
        _checkLimitValue(_simulatedShareRateDeviationBPLimit, 0, MAX_BASIS_POINTS);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.simulatedShareRateDeviationBPLimit = LimitsListPacker.toBasisPoints(_simulatedShareRateDeviationBPLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the maxBalanceExitRequestedPerReportInEth
    /// @param _maxBalanceExitRequestedPerReportInEth new maxBalanceExitRequestedPerReportInEth value
    function setMaxBalanceExitRequestedPerReportInEth(uint256 _maxBalanceExitRequestedPerReportInEth)
        external
        onlyRole(MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE)
    {
        _checkLimitValue(_maxBalanceExitRequestedPerReportInEth, 0, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxBalanceExitRequestedPerReportInEth = SafeCast.toUint16(_maxBalanceExitRequestedPerReportInEth);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new WC 0x01 max effective balance equivalent weight in ETH
    function setMaxEffectiveBalanceWeightWCType01(uint256 _maxEffectiveBalanceWeightWCType01)
        external
        onlyRole(MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE)
    {
        _checkLimitValue(_maxEffectiveBalanceWeightWCType01, 1, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxEffectiveBalanceWeightWCType01 = SafeCast.toUint16(_maxEffectiveBalanceWeightWCType01);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new WC 0x02 max effective balance equivalent weight in ETH
    function setMaxEffectiveBalanceWeightWCType02(uint256 _maxEffectiveBalanceWeightWCType02)
        external
        onlyRole(MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE)
    {
        _checkLimitValue(_maxEffectiveBalanceWeightWCType02, 1, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxEffectiveBalanceWeightWCType02 = SafeCast.toUint16(_maxEffectiveBalanceWeightWCType02);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new value for the requestTimestampMargin
    /// @param _requestTimestampMargin new requestTimestampMargin value
    function setRequestTimestampMargin(
        uint256 _requestTimestampMargin
    ) external onlyRole(REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE) {
        _checkLimitValue(_requestTimestampMargin, 0, type(uint32).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.requestTimestampMargin = SafeCast.toUint32(_requestTimestampMargin);
        _updateOperationalLimits(limits);
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
        _checkLimitValue(_maxPositiveTokenRebase, 1, type(uint64).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.maxPositiveTokenRebase = SafeCast.toUint64(_maxPositiveTokenRebase);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the maxItemsPerExtraDataTransaction
    /// @param _maxItemsPerExtraDataTransaction new maxItemsPerExtraDataTransaction value
    function setMaxItemsPerExtraDataTransaction(
        uint256 _maxItemsPerExtraDataTransaction
    ) external onlyRole(MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE) {
        _checkLimitValue(_maxItemsPerExtraDataTransaction, 0, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxItemsPerExtraDataTransaction = SafeCast.toUint16(_maxItemsPerExtraDataTransaction);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new value for the max maxNodeOperatorsPerExtraDataItem
    /// @param _maxNodeOperatorsPerExtraDataItem new maxNodeOperatorsPerExtraDataItem value
    function setMaxNodeOperatorsPerExtraDataItem(
        uint256 _maxNodeOperatorsPerExtraDataItem
    ) external onlyRole(MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE) {
        _checkLimitValue(_maxNodeOperatorsPerExtraDataItem, 0, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxNodeOperatorsPerExtraDataItem = SafeCast.toUint16(_maxNodeOperatorsPerExtraDataItem);
        _updateOperationalLimits(limits);
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
        _checkLimitValue(_clBalanceOraclesErrorUpperBPLimit, 0, MAX_BASIS_POINTS);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.clBalanceOraclesErrorUpperBPLimit = LimitsListPacker.toBasisPoints(_clBalanceOraclesErrorUpperBPLimit);
        _updateAccountingCoreLimits(limits);
        if (_secondOpinionOracle != secondOpinionOracle) {
            secondOpinionOracle = ISecondOpinionOracle(_secondOpinionOracle);
            emit SecondOpinionOracleChanged(_secondOpinionOracle);
        }
    }

    /// @notice Sets the max allowed CL balance decrease in basis points
    /// @param _maxCLBalanceDecreaseBP max CL balance decrease over the sliding window (in BP, e.g. 360 = 3.6%)
    function setMaxCLBalanceDecreaseBP(uint256 _maxCLBalanceDecreaseBP)
        external
        onlyRole(MAX_CL_BALANCE_DECREASE_MANAGER_ROLE)
    {
        _checkLimitValue(_maxCLBalanceDecreaseBP, 0, MAX_BASIS_POINTS);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.maxCLBalanceDecreaseBP = LimitsListPacker.toBasisPoints(_maxCLBalanceDecreaseBP);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice One-time migration: seeds initial snapshots into reportData
    ///     so that the sliding-window CL decrease check has a valid starting point.
    function migrateBaselineSnapshot() external onlyRole(MIGRATION_MANAGER_ROLE) {
        if (reportData.length != 0) revert MigrationAlreadyDone();

        address lidoAddr = LIDO_LOCATOR.lido();
        uint256 lidoVersion = IVersioned(lidoAddr).getContractVersion();
        if (lidoVersion != 4) revert UnexpectedLidoVersion(lidoVersion, 4);

        (uint256 migrationCLValidatorsBalance, uint256 migrationCLPendingBalance, uint256 migrationDeposits) = ILido(lidoAddr)
            .getBalanceStats();
        uint256 migrationCLBalance = migrationCLValidatorsBalance + migrationCLPendingBalance;
        uint256 migrationCLWithdrawals = MAX_WITHDRAWALS_ETH_BY_CHURN_LIMIT_PER_REPORT;

        // Initialize vault state: vault is not drained during migration,
        // so after-transfer balance equals current vault balance
        _lastVaultBalanceAfterTransfer = LIDO_LOCATOR.withdrawalVault().balance;

        // The decrease formula uses baseline report B[X-k] and sums flows from reports [X-k+1..X].
        // To include migration-time deposits/withdrawals without any special-case branch in formula code:
        // 1) store pure baseline point with zero flows;
        // 2) store bootstrap flow chunk at the same CL balance right after baseline.
        uint256 migrationReportTimestamp = _lastReportTimestamp;
        _addReportData(migrationReportTimestamp, migrationCLBalance, 0, 0);
        _addReportData(migrationReportTimestamp, migrationCLBalance, migrationDeposits, migrationCLWithdrawals);

        emit BaselineSnapshotMigrated(migrationCLBalance, migrationDeposits, migrationCLWithdrawals);
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
    /// @param _preCLValidatorsBalance sum of all Lido validators' balances on the Consensus Layer
    ///     before the current oracle report
    /// @param _preCLPendingBalance pending deposits balance on the Consensus Layer before the current oracle report
    /// @param _postCLValidatorsBalance sum of all Lido validators' balances on the Consensus Layer
    ///     after the current oracle report
    /// @param _postCLPendingBalance pending deposits balance on the Consensus Layer after the current oracle report
    /// @param _withdrawalVaultBalance withdrawal vault balance on Execution Layer for the report reference slot
    /// @param _elRewardsVaultBalance el rewards vault balance on Execution Layer for the report reference slot
    /// @param _sharesRequestedToBurn shares requested to burn for the report reference slot
    /// @param _deposits deposits to the Beacon Chain since the previous oracle report in Wei
    /// @param _withdrawalsVaultTransfer ETH amount transferred from withdrawal vault this report
    function checkAccountingOracleReport(
        uint256 _timeElapsed,
        uint256 _preCLValidatorsBalance,
        uint256 _preCLPendingBalance,
        uint256 _postCLValidatorsBalance,
        uint256 _postCLPendingBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _deposits,
        uint256 _withdrawalsVaultTransfer
    ) external {
        if (msg.sender != ACCOUNTING_ADDRESS) {
            revert CalledNotFromAccounting();
        }
        // 1. Withdrawals vault reported balance
        _checkWithdrawalVaultBalance(LIDO_LOCATOR.withdrawalVault().balance, _withdrawalVaultBalance);
        // 2. EL rewards vault reported balance
        _checkELRewardsVaultBalance(LIDO_LOCATOR.elRewardsVault().balance, _elRewardsVaultBalance);
        // 3. Burn requests
        _checkSharesRequestedToBurn(_sharesRequestedToBurn);
        _checkAccountingOracleReportCLBalances(
            _timeElapsed,
            _preCLValidatorsBalance,
            _preCLPendingBalance,
            _postCLValidatorsBalance,
            _postCLPendingBalance,
            _withdrawalVaultBalance,
            _deposits,
            _withdrawalsVaultTransfer
        );
    }

    function _checkAccountingOracleReportCLBalances(
        uint256 _timeElapsed,
        uint256 _preCLValidatorsBalance,
        uint256 _preCLPendingBalance,
        uint256 _postCLValidatorsBalance,
        uint256 _postCLPendingBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _deposits,
        uint256 _withdrawalsVaultTransfer
    ) internal {
        AccountingCoreLimitsPacked memory limitsList = _accountingCoreLimits;
        CLBalanceDecreaseCheckParams memory checkParams;
        checkParams.maxCLBalanceDecreaseBP = limitsList.maxCLBalanceDecreaseBP;
        checkParams.clBalanceOraclesErrorUpperBPLimit = limitsList.clBalanceOraclesErrorUpperBPLimit;
        checkParams.preCLBalance = _preCLValidatorsBalance + _preCLPendingBalance + _deposits;
        checkParams.postCLBalance = _postCLValidatorsBalance + _postCLPendingBalance;
        checkParams.withdrawalVaultBalance = _withdrawalVaultBalance;
        checkParams.withdrawalsVaultTransfer = _withdrawalsVaultTransfer;
        checkParams.deposits = _deposits;
        checkParams.timeElapsed = _timeElapsed;
        uint256 clWithdrawals = _getCLWithdrawals(_withdrawalVaultBalance);
        _checkWithdrawalsVaultTransfer(_withdrawalVaultBalance, _withdrawalsVaultTransfer);
        _checkCLPendingBalanceIncrease(
            limitsList,
            _timeElapsed,
            _preCLValidatorsBalance,
            _preCLPendingBalance,
            _postCLValidatorsBalance,
            _postCLPendingBalance,
            _deposits,
            clWithdrawals
        );
        // 4. Consensus Layer balance decrease
        _checkCLBalanceDecrease(checkParams, clWithdrawals);
        // 5. Consensus Layer annual balances increase
        _checkAnnualBalancesIncrease(limitsList, checkParams.preCLBalance, checkParams.postCLBalance, _timeElapsed);
        // 6. Consensus Layer balance increase rate
        if (checkParams.postCLBalance > checkParams.preCLBalance) {
            uint256 clBalanceIncreasePerDay =
                _normalizePerDay(checkParams.postCLBalance - checkParams.preCLBalance, _timeElapsed);
            _checkCLBalanceIncreaseRatePerDay(limitsList, clBalanceIncreasePerDay);
        }
        _shiftLastVaultBalanceAfterTransfer(_withdrawalVaultBalance, _withdrawalsVaultTransfer);
    }

    /// @notice Check total pending CL balance from the current report against protocol state and growth limits.
    function checkCLPendingBalanceIncrease(
        uint256 _timeElapsed,
        uint256 _preCLValidatorsBalance,
        uint256 _preCLPendingBalance,
        uint256 _postCLValidatorsBalance,
        uint256 _postCLPendingBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _deposits
    ) external view {
        _checkCLPendingBalanceIncrease(
            _accountingCoreLimits,
            _timeElapsed,
            _preCLValidatorsBalance,
            _preCLPendingBalance,
            _postCLValidatorsBalance,
            _postCLPendingBalance,
            _deposits,
            _getCLWithdrawals(_withdrawalVaultBalance)
        );
    }

    /// @notice Check that per-module validators/pending CL balances are consistent with reported totals.
    function checkCLBalancesConsistency(
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _validatorBalancesGweiByStakingModule,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _clValidatorsBalanceGwei,
        uint256 _clPendingBalanceGwei
    ) external pure {
        _checkCLBalancesConsistency(
            _stakingModuleIdsWithUpdatedBalance,
            _validatorBalancesGweiByStakingModule,
            _pendingBalancesGweiByStakingModule,
            _clValidatorsBalanceGwei,
            _clPendingBalanceGwei
        );
    }

    /// @notice Check per-day module validators and pending balances change rates against configured limits.
    function checkModuleAndCLBalancesChangeRates(
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _validatorBalancesGweiByStakingModule,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _clValidatorsBalanceGwei,
        uint256 _clPendingBalanceGwei,
        uint256 _timeElapsed
        ) external view {
        _checkCLBalancesConsistency(
            _stakingModuleIdsWithUpdatedBalance,
            _validatorBalancesGweiByStakingModule,
            _pendingBalancesGweiByStakingModule,
            _clValidatorsBalanceGwei,
            _clPendingBalanceGwei
        );

        IStakingRouter stakingRouter = IStakingRouter(LIDO_LOCATOR.stakingRouter());
        AccountingCoreLimitsPacked memory limitsList = _accountingCoreLimits;

        _checkModulePendingBalanceChangeRates(
            stakingRouter,
            limitsList,
            _stakingModuleIdsWithUpdatedBalance,
            _pendingBalancesGweiByStakingModule,
            _timeElapsed
        );

        uint256 moduleBalanceIncreasePerDay = _calculateModuleBalanceIncreasePerDay(
            stakingRouter,
            _stakingModuleIdsWithUpdatedBalance,
            _validatorBalancesGweiByStakingModule,
            _timeElapsed
        );

        _checkAppearedEthAmountPerDay(limitsList, moduleBalanceIncreasePerDay);
    }

    /// @notice Applies sanity checks to the number of validator exit requests supplied to ValidatorExitBusOracle
    /// @notice Checks the total balance of validator exit requests supplied per oracle report
    /// @param _maxBalanceExitRequestedPerReportInEth Total balance in ETH of all validators requested to exit in the oracle report
    function checkExitBusOracleReport(uint256 _maxBalanceExitRequestedPerReportInEth)
        external
        view
    {
        uint256 limit = _operationalLimits.maxBalanceExitRequestedPerReportInEth;
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
        AccountingCoreLimitsPacked memory limitsList = _accountingCoreLimits;
        uint256 exitedEthAmount = _newlyExitedValidatorsCount * uint256(limitsList.exitedValidatorEthAmountLimit) * 1 ether;
        uint256 exitedEthAmountPerDay = _normalizePerDay(exitedEthAmount, _timeElapsed);
        _checkExitedEthAmountPerDay(limitsList, exitedEthAmountPerDay);
    }

    /// @notice Check appeared ETH amount rate per day.
    /// @param _appearedEthAmountPerDay Appeared ETH amount per day in Wei.
    function checkAppearedEthAmountPerDay(uint256 _appearedEthAmountPerDay) external view {
        _checkAppearedEthAmountPerDay(_accountingCoreLimits, _appearedEthAmountPerDay);
    }

    /// @notice check the number of node operators reported per extra data item in the accounting oracle report.
    /// @param _itemIndex Index of item in extra data
    /// @param _nodeOperatorsCount Number of validator exit requests supplied per oracle report
    function checkNodeOperatorsPerExtraDataItemCount(uint256 _itemIndex, uint256 _nodeOperatorsCount) external view {
        uint256 limit = _operationalLimits.maxNodeOperatorsPerExtraDataItem;
        if (_nodeOperatorsCount > limit) {
            revert TooManyNodeOpsPerExtraDataItem(_itemIndex, _nodeOperatorsCount);
        }
    }

    /// @notice Check the number of extra data list items per transaction in the accounting oracle report.
    /// @param _extraDataListItemsCount Number of items per single transaction in the accounting oracle report
    function checkExtraDataItemsCountPerTransaction(uint256 _extraDataListItemsCount) external view {
        uint256 limit = _operationalLimits.maxItemsPerExtraDataTransaction;
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
        OperationalLimitsPacked memory limitsList = _operationalLimits;
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
        AccountingCoreLimitsPacked memory limitsList = _accountingCoreLimits;

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
        uint256[] calldata _validatorBalancesGweiByStakingModule,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _clValidatorsBalanceGwei,
        uint256 _clPendingBalanceGwei
    ) internal pure {
        uint256 modulesCount = _stakingModuleIdsWithUpdatedBalance.length;
        if (modulesCount != _validatorBalancesGweiByStakingModule.length || modulesCount != _pendingBalancesGweiByStakingModule.length) {
            revert InvalidClBalancesData();
        }

        uint256 validatorBalancesSum;
        uint256 pendingBalancesSum;
        for (uint256 i = 0; i < modulesCount;) {
            validatorBalancesSum += _validatorBalancesGweiByStakingModule[i];
            pendingBalancesSum += _pendingBalancesGweiByStakingModule[i];
            unchecked {
                ++i;
            }
        }

        if (validatorBalancesSum != _clValidatorsBalanceGwei) {
            revert InconsistentValidatorsBalanceByModule(_clValidatorsBalanceGwei, validatorBalancesSum);
        }
        if (pendingBalancesSum != _clPendingBalanceGwei) {
            revert InconsistentPendingBalanceByModule(_clPendingBalanceGwei, pendingBalancesSum);
        }
    }

    function _checkExitedEthAmountPerDay(
        AccountingCoreLimitsPacked memory _limitsList,
        uint256 _exitedEthAmountPerDay
    ) internal pure {
        uint256 exitedEthLimitWithConsolidation =
            (uint256(_limitsList.exitedEthAmountPerDayLimit) + uint256(_limitsList.consolidationEthAmountPerDayLimit)) *
            1 ether;
        if (_exitedEthAmountPerDay > exitedEthLimitWithConsolidation) {
            revert ExitedEthAmountPerDayLimitExceeded(exitedEthLimitWithConsolidation, _exitedEthAmountPerDay);
        }
    }

    function _checkAppearedEthAmountPerDay(
        AccountingCoreLimitsPacked memory _limitsList,
        uint256 _appearedEthAmountPerDay
    ) internal pure {
        uint256 appearedEthLimitWithConsolidation =
            (uint256(_limitsList.appearedEthAmountPerDayLimit) + uint256(_limitsList.consolidationEthAmountPerDayLimit)) *
            1 ether;
        if (_appearedEthAmountPerDay > appearedEthLimitWithConsolidation) {
            revert AppearedEthAmountPerDayLimitExceeded(appearedEthLimitWithConsolidation, _appearedEthAmountPerDay);
        }
    }

    function _checkCLBalanceIncreaseRatePerDay(
        AccountingCoreLimitsPacked memory _limitsList,
        uint256 _clBalanceIncreaseEthAmountPerDay
    ) internal pure {
        uint256 clBalanceIncreaseLimitPerDay = uint256(_limitsList.appearedEthAmountPerDayLimit) * 1 ether;
        if (_clBalanceIncreaseEthAmountPerDay > clBalanceIncreaseLimitPerDay) {
            revert CLBalanceIncreaseRatePerDayLimitExceeded(
                clBalanceIncreaseLimitPerDay,
                _clBalanceIncreaseEthAmountPerDay
            );
        }
    }

    function _calculateModuleBalanceIncreasePerDay(
        IStakingRouter _stakingRouter,
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _validatorBalancesGweiByStakingModule,
        uint256 _timeElapsed
    ) internal view returns (uint256 moduleBalanceIncreasePerDay) {
        uint256 validatorsBalanceIncrease;
        for (uint256 i = 0; i < _stakingModuleIdsWithUpdatedBalance.length;) {
            // TODO: what if it is new module without previous balance?
            (uint64 previousValidatorsBalanceGwei, , ) =
                _stakingRouter.getStakingModuleStateAccounting(_stakingModuleIdsWithUpdatedBalance[i]);

            uint256 previousValidatorsBalanceWei = uint256(previousValidatorsBalanceGwei) * 1 gwei;
            uint256 currentValidatorsBalanceWei = _validatorBalancesGweiByStakingModule[i] * 1 gwei;
            if (currentValidatorsBalanceWei >= previousValidatorsBalanceWei) {
                validatorsBalanceIncrease += currentValidatorsBalanceWei - previousValidatorsBalanceWei;
            }
            unchecked {
                ++i;
            }
        }

        moduleBalanceIncreasePerDay = _normalizePerDay(validatorsBalanceIncrease, _timeElapsed);
    }

    function _normalizePerDay(uint256 _amount, uint256 _timeElapsed) internal pure returns (uint256) {
        return (_amount * SECONDS_PER_DAY) / _getTimeElapsedForRateNormalization(_timeElapsed);
    }

    function _getTimeElapsedForRateNormalization(uint256 _timeElapsed) internal pure returns (uint256) {
        return _timeElapsed == 0 ? 1 : _timeElapsed;
    }

    function _getTimeElapsedForAllowanceChecks(uint256 _timeElapsed) internal pure returns (uint256) {
        return _timeElapsed == 0 ? DEFAULT_TIME_ELAPSED : _timeElapsed;
    }

    function _calculateAmountForPeriod(
        uint256 _amountPerDay,
        uint256 _effectiveTimeElapsed
    ) internal pure returns (uint256) {
        return (_amountPerDay * _effectiveTimeElapsed) / SECONDS_PER_DAY;
    }

    function _calculatePendingBalanceAdditionalLimit(
        uint256 _previousValidatorsBalanceGwei,
        uint256 _annualBalanceIncreaseMultiplier
    ) internal pure returns (uint256) {
        return (_previousValidatorsBalanceGwei * _annualBalanceIncreaseMultiplier) / ANNUAL_BALANCE_INCREASE_DENOMINATOR;
    }

    function _checkCLPendingBalanceIncrease(
        AccountingCoreLimitsPacked memory _limitsList,
        uint256 _timeElapsed,
        uint256 _preCLValidatorsBalance,
        uint256 _preCLPendingBalance,
        uint256 _postCLValidatorsBalance,
        uint256 _postCLPendingBalance,
        uint256 _deposits,
        uint256 _clWithdrawals
    ) internal pure {
        uint256 pendingByState = _preCLPendingBalance + _deposits;
        uint256 effectiveTimeElapsed = _getTimeElapsedForAllowanceChecks(_timeElapsed);

        uint256 previousValidatorsBalance = _preCLValidatorsBalance;
        uint256 currentValidatorsBalance = _postCLValidatorsBalance;

        uint256 maxPendingLimit = pendingByState +
            _calculatePendingBalanceAdditionalLimit(
                previousValidatorsBalance,
                uint256(_limitsList.annualBalanceIncreaseBPLimit) * effectiveTimeElapsed
            );

        uint256 appearedLimitPerPeriod =
            _calculateAmountForPeriod(uint256(_limitsList.appearedEthAmountPerDayLimit) * 1 ether, effectiveTimeElapsed);
        uint256 minPendingLimit = pendingByState > appearedLimitPerPeriod ? pendingByState - appearedLimitPerPeriod : 0;

        if (_clWithdrawals > previousValidatorsBalance) {
            revert InvalidClBalancesData();
        }

        uint256 validatorsBalanceBeforeCurrentReport = previousValidatorsBalance - _clWithdrawals;

        // Adjust maxPendingLimit by clAppearedBalance (signed difference handled via branches)
        if (currentValidatorsBalance >= validatorsBalanceBeforeCurrentReport) {
            uint256 clAppearedBalance = currentValidatorsBalance - validatorsBalanceBeforeCurrentReport;
            if (clAppearedBalance > maxPendingLimit) {
                revert IncorrectCLBalanceIncrease(clAppearedBalance);
            }
            maxPendingLimit -= clAppearedBalance;
        } else {
            maxPendingLimit += validatorsBalanceBeforeCurrentReport - currentValidatorsBalance;
        }

        if (_postCLPendingBalance < minPendingLimit || _postCLPendingBalance > maxPendingLimit) {
            revert IncorrectTotalPendingBalance(minPendingLimit, maxPendingLimit, _postCLPendingBalance);
        }
    }

    function _checkModulePendingBalanceChangeRates(
        IStakingRouter _stakingRouter,
        AccountingCoreLimitsPacked memory _limitsList,
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _timeElapsed
    ) internal view {
        uint256 modulesCount = _stakingModuleIdsWithUpdatedBalance.length;
        if (modulesCount != _pendingBalancesGweiByStakingModule.length) {
            revert InvalidClBalancesData();
        }

        uint256 effectiveTimeElapsed = _getTimeElapsedForAllowanceChecks(_timeElapsed);
        uint256 annualBalanceIncreaseMultiplier =
            uint256(_limitsList.annualBalanceIncreaseBPLimit) * effectiveTimeElapsed;
        uint256 appearedLimitPerPeriodGwei =
            _calculateAmountForPeriod((uint256(_limitsList.appearedEthAmountPerDayLimit) * 1 ether) / 1 gwei, effectiveTimeElapsed);

        uint256 totalActiveAppearedEthGwei = _accumulateModulePendingBalanceChanges(
            _stakingRouter,
            _stakingModuleIdsWithUpdatedBalance,
            _pendingBalancesGweiByStakingModule,
            annualBalanceIncreaseMultiplier,
            appearedLimitPerPeriodGwei
        );

        if (totalActiveAppearedEthGwei > appearedLimitPerPeriodGwei) {
            revert IncorrectTotalActiveAppearedEth(appearedLimitPerPeriodGwei, totalActiveAppearedEthGwei);
        }
    }

    function _accumulateModulePendingBalanceChanges(
        IStakingRouter _stakingRouter,
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _pendingBalancesGweiByStakingModule,
        uint256 _annualBalanceIncreaseMultiplier,
        uint256 _appearedLimitPerPeriodGwei
    ) internal view returns (uint256 totalActiveAppearedEthGwei) {
        uint256 modulesCount = _stakingModuleIdsWithUpdatedBalance.length;
        for (uint256 i = 0; i < modulesCount;) {
            uint256 activeAppearedEthGwei = _checkSingleModulePendingBalanceChangeRate(
                _stakingRouter,
                _stakingModuleIdsWithUpdatedBalance[i],
                _pendingBalancesGweiByStakingModule[i],
                _annualBalanceIncreaseMultiplier,
                _appearedLimitPerPeriodGwei
            );
            totalActiveAppearedEthGwei += activeAppearedEthGwei;

            unchecked {
                ++i;
            }
        }
    }

    function _checkSingleModulePendingBalanceChangeRate(
        IStakingRouter _stakingRouter,
        uint256 _moduleId,
        uint256 _currentPendingBalanceGwei,
        uint256 _annualBalanceIncreaseMultiplier,
        uint256 _appearedLimitPerPeriodGwei
    ) internal view returns (uint256 activeAppearedEthGwei) {
        (uint64 previousValidatorsBalanceGweiRaw, uint64 pendingBalanceBeforeReportGwei, ) =
            _stakingRouter.getStakingModuleStateAccounting(_moduleId);

        // The module pending balance immediately before the current report is applied.
        // It is seeded by the previous report via `reportValidatorBalancesByStakingModule(...)` and then
        // increased by deposits through `_updateModulePendingBalance(...)` until the next report.
        // The current report's pending balance is checked against a corridor around this pre-report baseline.
        uint256 pendingBalanceBaselineGwei = uint256(pendingBalanceBeforeReportGwei);
        activeAppearedEthGwei = pendingBalanceBaselineGwei > _currentPendingBalanceGwei
            ? pendingBalanceBaselineGwei - _currentPendingBalanceGwei
            : 0;
        uint256 additionalLimit =
            _calculatePendingBalanceAdditionalLimit(uint256(previousValidatorsBalanceGweiRaw), _annualBalanceIncreaseMultiplier);
        uint256 lowerBound = pendingBalanceBaselineGwei > _appearedLimitPerPeriodGwei
            ? pendingBalanceBaselineGwei - _appearedLimitPerPeriodGwei
            : 0;
        uint256 upperBound = pendingBalanceBaselineGwei + additionalLimit;

        if (_currentPendingBalanceGwei < lowerBound || _currentPendingBalanceGwei > upperBound) {
            revert IncorrectModulePendingBalance(
                _moduleId,
                lowerBound,
                upperBound,
                _currentPendingBalanceGwei
            );
        }
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

    function _addReportData(
        uint256 _timestamp,
        uint256 _clBalance,
        uint256 _deposits,
        uint256 _clWithdrawals
    ) internal {
        reportData.push(
            ReportData({
                timestamp: SafeCast.toUint64(_timestamp),
                clBalance: SafeCast.toUint128(_clBalance),
                deposits: SafeCast.toUint128(_deposits),
                clWithdrawals: SafeCast.toUint128(_clWithdrawals)
            })
        );
    }

    function _checkCLBalanceDecrease(
        CLBalanceDecreaseCheckParams memory _checkParams,
        uint256 _clWithdrawals
    ) internal {
        // Compute actual CL withdrawals for this period:
        // clWithdrawals = current vault balance - vault balance after last report's transfer
        uint256 reportTimestamp = _lastReportTimestamp + _checkParams.timeElapsed;
        _addReportData(reportTimestamp, _checkParams.postCLBalance, _checkParams.deposits, _clWithdrawals);
        _lastReportTimestamp = reportTimestamp;

        // If the CL balance didn't decrease accounting for withdrawals, skip the window check
        if (_checkParams.preCLBalance <= _checkParams.postCLBalance) return;
        if (_checkParams.preCLBalance - _checkParams.postCLBalance <= _clWithdrawals) return;

        uint256 len = reportData.length;
        // Need at least two snapshots to build a window: baseline B[X-k] and current point B[X].
        // With migration we seed them upfront (baseline + bootstrap flow chunk), so checks work immediately.
        // Without migration this still works, but the very first report cannot be checked and pre-deploy
        // state is not part of the window until enough post-deploy snapshots are accumulated.
        if (len < 2) return;

        (uint256 actualCLBalanceDiff, uint256 maxAllowedCLBalanceDiff) = _calcWindowDiff(
            _checkParams.maxCLBalanceDecreaseBP,
            _checkParams.postCLBalance,
            len
        );

        if (actualCLBalanceDiff == 0) return;
        uint256 refSlot = IBaseOracle(LIDO_LOCATOR.accountingOracle()).getLastProcessingRefSlot();

        if (actualCLBalanceDiff > maxAllowedCLBalanceDiff) {
            if (address(secondOpinionOracle) == address(0)) {
                revert IncorrectCLBalanceDecrease(actualCLBalanceDiff, maxAllowedCLBalanceDiff);
            }
            _askSecondOpinion(
                refSlot,
                _checkParams.postCLBalance,
                _checkParams.withdrawalVaultBalance,
                _checkParams.clBalanceOraclesErrorUpperBPLimit
            );
            return;
        }

        emit NegativeCLRebaseAccepted(
            refSlot,
            _checkParams.postCLBalance,
            actualCLBalanceDiff,
            maxAllowedCLBalanceDiff
        );
    }

    function _getCLWithdrawals(uint256 _withdrawalVaultBalance) internal view returns (uint256) {
        if (_withdrawalVaultBalance < _lastVaultBalanceAfterTransfer) {
            revert IncorrectCLWithdrawalsVaultBalance(_withdrawalVaultBalance, _lastVaultBalanceAfterTransfer);
        }
        return _withdrawalVaultBalance - _lastVaultBalanceAfterTransfer;
    }

    function _checkWithdrawalsVaultTransfer(
        uint256 _withdrawalVaultBalance,
        uint256 _withdrawalsVaultTransfer
    ) internal pure {
        // In the current Accounting flow `withdrawalsVaultTransfer` comes from `smoothenTokenRebase()`,
        // where it is capped by `_withdrawalVaultBalance`, so the subtraction below cannot underflow.
        // Keep this explicit guard anyway because `checkAccountingOracleReport` still receives it as an external input.
        if (_withdrawalsVaultTransfer > _withdrawalVaultBalance) {
            revert IncorrectWithdrawalsVaultTransfer(_withdrawalVaultBalance, _withdrawalsVaultTransfer);
        }
    }

    function _shiftLastVaultBalanceAfterTransfer(
        uint256 _withdrawalVaultBalance,
        uint256 _withdrawalsVaultTransfer
    ) internal {
        _lastVaultBalanceAfterTransfer = _withdrawalVaultBalance - _withdrawalsVaultTransfer;
    }

    function _calcWindowDiff(
        uint256 _maxDecreaseBP,
        uint256 _postCLBalance,
        uint256 _reportCount
    ) internal view returns (uint256 actualCLBalanceDiff, uint256 maxAllowedCLBalanceDiff) {
        // Window formula:
        // adjustedBase = B[baseline] + sum(deposits) - sum(clWithdrawals)
        // actualDiff   = abs(B[baseline] - B[current])
        // maxAllowed   = adjustedBase * limitBP / 10_000
        uint256 lastIndex = _reportCount - 1;
        uint256 lastTimestamp = reportData[lastIndex].timestamp;
        uint256 windowStart = lastTimestamp > CL_BALANCE_WINDOW ? lastTimestamp - CL_BALANCE_WINDOW : 0;
        uint256 baselineIndex = _findWindowStartIndex(lastIndex, windowStart);

        uint256 baselineBalance = reportData[baselineIndex].clBalance;
        actualCLBalanceDiff = baselineBalance > _postCLBalance
            ? baselineBalance - _postCLBalance
            : _postCLBalance - baselineBalance;

        uint256 totalDeposits;
        uint256 totalCLWithdrawals;
        for (uint256 i = baselineIndex + 1; i <= lastIndex; ++i) {
            totalDeposits += reportData[i].deposits;
            totalCLWithdrawals += reportData[i].clWithdrawals;
        }

        uint256 adjustedBase = baselineBalance + totalDeposits;
        if (adjustedBase < totalCLWithdrawals) {
            revert IncorrectCLBalanceDecreaseWindowData(baselineBalance, totalDeposits, totalCLWithdrawals);
        }
        adjustedBase -= totalCLWithdrawals;

        maxAllowedCLBalanceDiff = (adjustedBase * _maxDecreaseBP) / MAX_BASIS_POINTS;
    }

    function _findWindowStartIndex(
        uint256 _lastIndex,
        uint256 _windowStart
    ) internal view returns (uint256 windowStartIndex) {
        windowStartIndex = _lastIndex;
        while (windowStartIndex > 0 && reportData[windowStartIndex - 1].timestamp >= _windowStart) {
            --windowStartIndex;
        }
    }

    function _askSecondOpinion(
        uint256 _refSlot,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _clBalanceOraclesErrorUpperBPLimit
    ) internal {
        (bool success, uint256 clOracleBalanceGwei, uint256 oracleWithdrawalVaultBalanceWei, , ) = secondOpinionOracle
            .getReport(_refSlot);

        if (success) {
            uint256 clBalanceWei = clOracleBalanceGwei * 1 gwei;
            if (clBalanceWei < _postCLBalance) {
                revert NegativeRebaseFailedCLBalanceMismatch(
                    _postCLBalance,
                    clBalanceWei,
                    _clBalanceOraclesErrorUpperBPLimit
                );
            }
            if (
                MAX_BASIS_POINTS * (clBalanceWei - _postCLBalance) >
                _clBalanceOraclesErrorUpperBPLimit * clBalanceWei
            ) {
                revert NegativeRebaseFailedCLBalanceMismatch(
                    _postCLBalance,
                    clBalanceWei,
                    _clBalanceOraclesErrorUpperBPLimit
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
        AccountingCoreLimitsPacked memory _limitsList,
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

        _timeElapsed = _getTimeElapsedForAllowanceChecks(_timeElapsed);

        uint256 balanceIncrease = _postCLBalance - _preCLBalance;
        uint256 annualBalanceIncrease = (ANNUAL_BALANCE_INCREASE_DENOMINATOR * balanceIncrease) / _preCLBalance /
            _timeElapsed;

        if (annualBalanceIncrease > _limitsList.annualBalanceIncreaseBPLimit) {
            revert IncorrectCLBalanceIncrease(annualBalanceIncrease);
        }
    }

    function _checkLastFinalizableId(
        OperationalLimitsPacked memory _limitsList,
        address _withdrawalQueue,
        uint256 _lastFinalizableId,
        uint256 _reportTimestamp
    ) internal view {
        uint256[] memory requestIds = new uint256[](1);
        requestIds[0] = _lastFinalizableId;

        IWithdrawalQueue.WithdrawalRequestStatus[] memory statuses = IWithdrawalQueue(_withdrawalQueue)
            .getWithdrawalStatus(requestIds);
        if (_reportTimestamp < statuses[0].timestamp + uint256(_limitsList.requestTimestampMargin))
            revert IncorrectRequestFinalization(statuses[0].timestamp);
    }

    function _checkSimulatedShareRate(
        AccountingCoreLimitsPacked memory _limitsList,
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
        _validateLimitsList(_newLimitsList);
        _updateAccountingCoreLimits(_newLimitsList.packAccountingCore());
        _updateOperationalLimits(_newLimitsList.packOperational());
    }

    function _checkLimitValue(uint256 _value, uint256 _minAllowedValue, uint256 _maxAllowedValue) internal pure {
        if (_value > _maxAllowedValue || _value < _minAllowedValue) {
            revert IncorrectLimitValue(_value, _minAllowedValue, _maxAllowedValue);
        }
    }

    function _validateLimitsList(LimitsList memory _limitsList) internal pure {
        _checkLimitValue(_limitsList.exitedEthAmountPerDayLimit, 0, type(uint32).max);
        _checkLimitValue(_limitsList.appearedEthAmountPerDayLimit, 0, type(uint32).max);
        _checkLimitValue(_limitsList.consolidationEthAmountPerDayLimit, 0, type(uint32).max);
        _checkLimitValue(_limitsList.exitedValidatorEthAmountLimit, 1, type(uint16).max);
        _checkLimitValue(_limitsList.annualBalanceIncreaseBPLimit, 0, MAX_BASIS_POINTS);
        _checkLimitValue(_limitsList.simulatedShareRateDeviationBPLimit, 0, MAX_BASIS_POINTS);
        _checkLimitValue(_limitsList.maxBalanceExitRequestedPerReportInEth, 0, type(uint16).max);
        _checkLimitValue(_limitsList.maxEffectiveBalanceWeightWCType01, 1, type(uint16).max);
        _checkLimitValue(_limitsList.maxEffectiveBalanceWeightWCType02, 1, type(uint16).max);
        _checkLimitValue(_limitsList.maxItemsPerExtraDataTransaction, 0, type(uint16).max);
        _checkLimitValue(_limitsList.maxNodeOperatorsPerExtraDataItem, 0, type(uint16).max);
        _checkLimitValue(_limitsList.requestTimestampMargin, 0, type(uint32).max);
        _checkLimitValue(_limitsList.maxPositiveTokenRebase, 1, type(uint64).max);
        _checkLimitValue(_limitsList.maxCLBalanceDecreaseBP, 0, MAX_BASIS_POINTS);
        _checkLimitValue(_limitsList.clBalanceOraclesErrorUpperBPLimit, 0, MAX_BASIS_POINTS);
    }

    function _updateAccountingCoreLimits(AccountingCoreLimitsPacked memory _newLimits) internal {
        AccountingCoreLimitsPacked memory _oldLimits = _accountingCoreLimits;

        if (_oldLimits.exitedEthAmountPerDayLimit != _newLimits.exitedEthAmountPerDayLimit) {
            emit ExitedEthAmountPerDayLimitSet(_newLimits.exitedEthAmountPerDayLimit);
        }
        if (_oldLimits.appearedEthAmountPerDayLimit != _newLimits.appearedEthAmountPerDayLimit) {
            emit AppearedEthAmountPerDayLimitSet(_newLimits.appearedEthAmountPerDayLimit);
        }
        if (_oldLimits.consolidationEthAmountPerDayLimit != _newLimits.consolidationEthAmountPerDayLimit) {
            emit ConsolidationEthAmountPerDayLimitSet(_newLimits.consolidationEthAmountPerDayLimit);
        }
        if (_oldLimits.exitedValidatorEthAmountLimit != _newLimits.exitedValidatorEthAmountLimit) {
            emit ExitedValidatorEthAmountLimitSet(_newLimits.exitedValidatorEthAmountLimit);
        }
        if (_oldLimits.annualBalanceIncreaseBPLimit != _newLimits.annualBalanceIncreaseBPLimit) {
            emit AnnualBalanceIncreaseBPLimitSet(_newLimits.annualBalanceIncreaseBPLimit);
        }
        if (_oldLimits.simulatedShareRateDeviationBPLimit != _newLimits.simulatedShareRateDeviationBPLimit) {
            emit SimulatedShareRateDeviationBPLimitSet(_newLimits.simulatedShareRateDeviationBPLimit);
        }
        if (_oldLimits.maxPositiveTokenRebase != _newLimits.maxPositiveTokenRebase) {
            emit MaxPositiveTokenRebaseSet(_newLimits.maxPositiveTokenRebase);
        }
        if (_oldLimits.maxCLBalanceDecreaseBP != _newLimits.maxCLBalanceDecreaseBP) {
            emit MaxCLBalanceDecreaseBPSet(_newLimits.maxCLBalanceDecreaseBP);
        }
        if (_oldLimits.clBalanceOraclesErrorUpperBPLimit != _newLimits.clBalanceOraclesErrorUpperBPLimit) {
            emit CLBalanceOraclesErrorUpperBPLimitSet(_newLimits.clBalanceOraclesErrorUpperBPLimit);
        }

        _accountingCoreLimits = _newLimits;
    }

    function _updateOperationalLimits(OperationalLimitsPacked memory _newLimits) internal {
        OperationalLimitsPacked memory _oldLimits = _operationalLimits;

        if (_oldLimits.maxBalanceExitRequestedPerReportInEth != _newLimits.maxBalanceExitRequestedPerReportInEth) {
            emit MaxBalanceExitRequestedPerReportInEthSet(_newLimits.maxBalanceExitRequestedPerReportInEth);
        }
        if (_oldLimits.maxEffectiveBalanceWeightWCType01 != _newLimits.maxEffectiveBalanceWeightWCType01) {
            emit MaxEffectiveBalanceWeightWCType01Set(_newLimits.maxEffectiveBalanceWeightWCType01);
        }
        if (_oldLimits.maxEffectiveBalanceWeightWCType02 != _newLimits.maxEffectiveBalanceWeightWCType02) {
            emit MaxEffectiveBalanceWeightWCType02Set(_newLimits.maxEffectiveBalanceWeightWCType02);
        }
        if (_oldLimits.maxItemsPerExtraDataTransaction != _newLimits.maxItemsPerExtraDataTransaction) {
            emit MaxItemsPerExtraDataTransactionSet(_newLimits.maxItemsPerExtraDataTransaction);
        }
        if (_oldLimits.maxNodeOperatorsPerExtraDataItem != _newLimits.maxNodeOperatorsPerExtraDataItem) {
            emit MaxNodeOperatorsPerExtraDataItemSet(_newLimits.maxNodeOperatorsPerExtraDataItem);
        }
        if (_oldLimits.requestTimestampMargin != _newLimits.requestTimestampMargin) {
            emit RequestTimestampMarginSet(_newLimits.requestTimestampMargin);
        }

        _operationalLimits = _newLimits;
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
    event MaxEffectiveBalanceWeightWCType01Set(uint256 maxEffectiveBalanceWeightWCType01);
    event MaxEffectiveBalanceWeightWCType02Set(uint256 maxEffectiveBalanceWeightWCType02);
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
    error InconsistentValidatorsBalanceByModule(uint256 expected, uint256 actual);
    error InconsistentPendingBalanceByModule(uint256 expected, uint256 actual);
    error IncorrectTotalPendingBalance(uint256 minAllowed, uint256 maxAllowed, uint256 actual);
    error IncorrectModulePendingBalance(uint256 moduleId, uint256 minAllowed, uint256 maxAllowed, uint256 actual);
    error IncorrectTotalActiveAppearedEth(uint256 maxAllowed, uint256 actual);
    error AppearedEthAmountPerDayLimitExceeded(uint256 limitPerDay, uint256 appearedPerDay);
    error CLBalanceIncreaseRatePerDayLimitExceeded(uint256 limitPerDay, uint256 increasePerDay);
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
    error IncorrectCLWithdrawalsVaultBalance(
        uint256 withdrawalVaultBalance,
        uint256 lastWithdrawalVaultBalanceAfterTransfer
    );
    error IncorrectWithdrawalsVaultTransfer(uint256 withdrawalVaultBalance, uint256 withdrawalsVaultTransfer);
    error IncorrectCLBalanceDecreaseWindowData(
        uint256 baselineBalance,
        uint256 totalDeposits,
        uint256 totalCLWithdrawals
    );
    error MigrationAlreadyDone();
    error UnexpectedLidoVersion(uint256 actual, uint256 expected);

    event BaselineSnapshotMigrated(uint256 clBalance, uint256 deposits, uint256 clWithdrawals);
}

library LimitsListPacker {
    error BasisPointsOverflow(uint256 value, uint256 maxValue);

    function packAccountingCore(
        LimitsList memory _limitsList
    ) internal pure returns (AccountingCoreLimitsPacked memory res) {
        res.exitedEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.exitedEthAmountPerDayLimit);
        res.appearedEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.appearedEthAmountPerDayLimit);
        res.consolidationEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.consolidationEthAmountPerDayLimit);
        res.annualBalanceIncreaseBPLimit = toBasisPoints(_limitsList.annualBalanceIncreaseBPLimit);
        res.simulatedShareRateDeviationBPLimit = toBasisPoints(_limitsList.simulatedShareRateDeviationBPLimit);
        res.maxPositiveTokenRebase = SafeCast.toUint64(_limitsList.maxPositiveTokenRebase);
        res.maxCLBalanceDecreaseBP = toBasisPoints(_limitsList.maxCLBalanceDecreaseBP);
        res.clBalanceOraclesErrorUpperBPLimit = toBasisPoints(_limitsList.clBalanceOraclesErrorUpperBPLimit);
        res.exitedValidatorEthAmountLimit = SafeCast.toUint16(_limitsList.exitedValidatorEthAmountLimit);
    }

    function packOperational(
        LimitsList memory _limitsList
    ) internal pure returns (OperationalLimitsPacked memory res) {
        res.maxBalanceExitRequestedPerReportInEth = SafeCast.toUint16(_limitsList.maxBalanceExitRequestedPerReportInEth);
        res.maxEffectiveBalanceWeightWCType01 = SafeCast.toUint16(_limitsList.maxEffectiveBalanceWeightWCType01);
        res.maxEffectiveBalanceWeightWCType02 = SafeCast.toUint16(_limitsList.maxEffectiveBalanceWeightWCType02);
        res.maxItemsPerExtraDataTransaction = SafeCast.toUint16(_limitsList.maxItemsPerExtraDataTransaction);
        res.maxNodeOperatorsPerExtraDataItem = SafeCast.toUint16(_limitsList.maxNodeOperatorsPerExtraDataItem);
        res.requestTimestampMargin = SafeCast.toUint32(_limitsList.requestTimestampMargin);
    }

    function toBasisPoints(uint256 _value) internal pure returns (uint16) {
        if (_value > MAX_BASIS_POINTS) {
            revert BasisPointsOverflow(_value, MAX_BASIS_POINTS);
        }
        return uint16(_value);
    }
}

library LimitsListUnpacker {
    function unpack(
        AccountingCoreLimitsPacked memory _accountingLimits,
        OperationalLimitsPacked memory _operationalLimitsPacked
    ) internal pure returns (LimitsList memory res) {
        res.exitedEthAmountPerDayLimit = _accountingLimits.exitedEthAmountPerDayLimit;
        res.appearedEthAmountPerDayLimit = _accountingLimits.appearedEthAmountPerDayLimit;
        res.annualBalanceIncreaseBPLimit = _accountingLimits.annualBalanceIncreaseBPLimit;
        res.simulatedShareRateDeviationBPLimit = _accountingLimits.simulatedShareRateDeviationBPLimit;
        res.maxBalanceExitRequestedPerReportInEth = _operationalLimitsPacked.maxBalanceExitRequestedPerReportInEth;
        res.maxEffectiveBalanceWeightWCType01 = _operationalLimitsPacked.maxEffectiveBalanceWeightWCType01;
        res.maxEffectiveBalanceWeightWCType02 = _operationalLimitsPacked.maxEffectiveBalanceWeightWCType02;
        res.maxItemsPerExtraDataTransaction = _operationalLimitsPacked.maxItemsPerExtraDataTransaction;
        res.maxNodeOperatorsPerExtraDataItem = _operationalLimitsPacked.maxNodeOperatorsPerExtraDataItem;
        res.requestTimestampMargin = _operationalLimitsPacked.requestTimestampMargin;
        res.maxPositiveTokenRebase = _accountingLimits.maxPositiveTokenRebase;
        res.maxCLBalanceDecreaseBP = _accountingLimits.maxCLBalanceDecreaseBP;
        res.clBalanceOraclesErrorUpperBPLimit = _accountingLimits.clBalanceOraclesErrorUpperBPLimit;
        res.consolidationEthAmountPerDayLimit = _accountingLimits.consolidationEthAmountPerDayLimit;
        res.exitedValidatorEthAmountLimit = _accountingLimits.exitedValidatorEthAmountLimit;
    }
}
