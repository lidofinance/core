// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable one-contract-per-file
pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import {Math256} from "contracts/common/lib/Math256.sol";
import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {ISecondOpinionOracle} from "../interfaces/ISecondOpinionOracle.sol";
import {
    MAX_BASIS_POINTS,
    LimitsList,
    AccountingCoreLimitsPacked,
    OperationalLimitsPacked,
    LimitsListPacker,
    LimitsListUnpacker,
    LimitsListValidator
} from "./OracleReportLimits.sol";

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
    function getConsensusReport() external view returns (
        bytes32 hash,
        uint256 refSlot,
        uint256 processingDeadlineTime,
        bool processingStarted
    );
}

interface IStakingRouter {
    function getStakingModuleStateAccounting(uint256 _stakingModuleId)
        external
        view
        returns (
            uint64 validatorsBalanceGwei,
            uint64 exitedValidatorsCount
        );
}

struct CLBalanceChangeCheckParams {
    uint256 timeElapsed;
    uint256 preCLValidatorsBalance;
    uint256 preCLPendingBalance;
    uint256 postCLValidatorsBalance;
    uint256 postCLPendingBalance;
    uint256 deposits;
}

struct ActivationBalanceCheckResult {
    uint256 effectiveTimeElapsed;
    uint256 maxPossibleActivatedBalance;
}

uint256 constant SHARE_RATE_PRECISION_E27 = 1e27;

/// @title Sanity checks for the Lido's oracle report
/// @notice The contracts contain methods to perform sanity checks of the Lido's oracle report
///     and lever methods for granular tuning of the params of the checks
contract OracleReportSanityChecker is AccessControlEnumerable {
    using LimitsListPacker for LimitsList;
    using LimitsListUnpacker for AccountingCoreLimitsPacked;

    bytes32 public constant ALL_LIMITS_MANAGER_ROLE = keccak256("ALL_LIMITS_MANAGER_ROLE");
    bytes32 public constant EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE =
        keccak256("EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE");
    bytes32 public constant EXTERNAL_PENDING_BALANCE_CAP_MANAGER_ROLE =
        keccak256("EXTERNAL_PENDING_BALANCE_CAP_MANAGER_ROLE");
    bytes32 public constant ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE =
        keccak256("ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE");
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
    bytes32 public constant SECOND_OPINION_MANAGER_ROLE = keccak256("SECOND_OPINION_MANAGER_ROLE");
    bytes32 public constant CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE =
        keccak256("CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE");
    uint256 private constant DEFAULT_TIME_ELAPSED = 1 hours;
    uint256 private constant DEFAULT_CL_BALANCE = 1 gwei;
    uint256 private constant SECONDS_PER_DAY = 24 * 60 * 60;
    uint256 private constant ANNUAL_BALANCE_INCREASE_DENOMINATOR = 365 days * MAX_BASIS_POINTS;
    /// @dev Electra max effective balance of a single validator. The appeared ETH limit is prorated by elapsed time,
    ///      while CL activations are discrete, so one max validator is allowed as a report-window boundary allowance.
    uint256 private constant MAX_VALIDATOR_EFFECTIVE_BALANCE = 2_048 ether;

    ILidoLocator private immutable LIDO_LOCATOR;
    address private immutable ACCOUNTING_ADDRESS;

    AccountingCoreLimitsPacked private _accountingCoreLimits;
    OperationalLimitsPacked private _operationalLimits;

    /// @dev The address of the second opinion oracle
    ISecondOpinionOracle public secondOpinionOracle;

    /// @param _lidoLocator address of the LidoLocator instance
    /// @param _accounting address of the Accounting instance
    /// @param _admin address to grant DEFAULT_ADMIN_ROLE of the AccessControl contract
    /// @param _limitsList initial values to be set for the limits list
    /// @param _secondOpinionOracle initial second-opinion provider; can be zero to leave it disabled
    constructor(
        address _lidoLocator,
        address _accounting,
        address _admin,
        LimitsList memory _limitsList,
        ISecondOpinionOracle _secondOpinionOracle
    ) {
        if (_admin == address(0)) revert AdminCannotBeZero();
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);
        ACCOUNTING_ADDRESS = _accounting;

        _updateLimits(_limitsList);
        secondOpinionOracle = _secondOpinionOracle;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice returns the address of the LidoLocator
    function getLidoLocator() public view returns (address) {
        return address(LIDO_LOCATOR);
    }

    /// @notice Returns the limits list for the Lido's oracle report sanity checks
    function getOracleReportLimits() public view returns (LimitsList memory) {
        return _accountingCoreLimits.unpack(_operationalLimits);
    }

    function getMaxEffectiveBalanceWeightWCType01() external view returns (uint256) {
        return _operationalLimits.maxEffectiveBalanceWeightWCType01;
    }

    function getMaxEffectiveBalanceWeightWCType02() external view returns (uint256) {
        return _operationalLimits.maxEffectiveBalanceWeightWCType02;
    }

    /// @notice Sets the new values for the limits list and second opinion oracle
    /// @param _limitsList new limits list
    /// @param _secondOpinionOracle second-opinion provider.
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
        LimitsListValidator.checkLimitValue(_exitedEthAmountPerDayLimit, 0, type(uint32).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.exitedEthAmountPerDayLimit = SafeCast.toUint32(_exitedEthAmountPerDayLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the appearedEthAmountPerDayLimit
    /// @param _appearedEthAmountPerDayLimit new appearedEthAmountPerDayLimit value
    function setAppearedEthAmountPerDayLimit(
        uint256 _appearedEthAmountPerDayLimit
    ) public onlyRole(APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE) {
        LimitsListValidator.checkLimitValue(_appearedEthAmountPerDayLimit, 0, type(uint32).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.appearedEthAmountPerDayLimit = SafeCast.toUint32(_appearedEthAmountPerDayLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the consolidationEthAmountPerDayLimit
    /// @param _consolidationEthAmountPerDayLimit new consolidationEthAmountPerDayLimit value
    function setConsolidationEthAmountPerDayLimit(
        uint256 _consolidationEthAmountPerDayLimit
    ) external onlyRole(CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE) {
        LimitsListValidator.checkLimitValue(_consolidationEthAmountPerDayLimit, 0, type(uint32).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.consolidationEthAmountPerDayLimit = SafeCast.toUint32(_consolidationEthAmountPerDayLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets exited validator ETH amount limiter value.
    function setExitedValidatorEthAmountLimit(
        uint256 _exitedValidatorEthAmountLimit
    ) external onlyRole(EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE) {
        LimitsListValidator.checkLimitValue(_exitedValidatorEthAmountLimit, 1, type(uint16).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.exitedValidatorEthAmountLimit = SafeCast.toUint16(_exitedValidatorEthAmountLimit);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the extra external pending balance cap tolerated above Lido-funded pending.
    /// @dev Stored in whole ETH units to keep accounting core limits within a single storage slot.
    function setExternalPendingBalanceCapEth(
        uint256 _externalPendingBalanceCapEth
    ) external onlyRole(EXTERNAL_PENDING_BALANCE_CAP_MANAGER_ROLE) {
        LimitsListValidator.checkLimitValue(_externalPendingBalanceCapEth, 0, type(uint16).max);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.externalPendingBalanceCapEth = SafeCast.toUint16(_externalPendingBalanceCapEth);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the soft and hard annualized limits for a positive CL accounting rebase.
    function setAnnualCLRebaseIncreaseBPLimits(
        uint256 _softLimitBP,
        uint256 _hardLimitBP
    ) external onlyRole(ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE) {
        LimitsListValidator.checkLimitValue(_hardLimitBP, 0, MAX_BASIS_POINTS);
        LimitsListValidator.checkLimitValue(_softLimitBP, 0, _hardLimitBP);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.annualCLRebaseIncreaseSoftBPLimit = LimitsListPacker.toBasisPoints(_softLimitBP);
        limits.annualCLRebaseIncreaseHardBPLimit = LimitsListPacker.toBasisPoints(_hardLimitBP);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Sets the new value for the simulatedShareRateDeviationBPLimit
    /// @param _simulatedShareRateDeviationBPLimit new simulatedShareRateDeviationBPLimit value
    function setSimulatedShareRateDeviationBPLimit(uint256 _simulatedShareRateDeviationBPLimit)
        external
        onlyRole(SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE)
    {
        LimitsListValidator.checkLimitValue(_simulatedShareRateDeviationBPLimit, 0, MAX_BASIS_POINTS);
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
        LimitsListValidator.checkLimitValue(_maxBalanceExitRequestedPerReportInEth, 0, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxBalanceExitRequestedPerReportInEth = SafeCast.toUint16(_maxBalanceExitRequestedPerReportInEth);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new WC 0x01 max effective balance equivalent weight in ETH
    function setMaxEffectiveBalanceWeightWCType01(uint256 _maxEffectiveBalanceWeightWCType01)
        external
        onlyRole(MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE)
    {
        LimitsListValidator.checkLimitValue(_maxEffectiveBalanceWeightWCType01, 1, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxEffectiveBalanceWeightWCType01 = SafeCast.toUint16(_maxEffectiveBalanceWeightWCType01);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new WC 0x02 max effective balance equivalent weight in ETH
    function setMaxEffectiveBalanceWeightWCType02(uint256 _maxEffectiveBalanceWeightWCType02)
        external
        onlyRole(MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE)
    {
        LimitsListValidator.checkLimitValue(_maxEffectiveBalanceWeightWCType02, 1, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxEffectiveBalanceWeightWCType02 = SafeCast.toUint16(_maxEffectiveBalanceWeightWCType02);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new value for the requestTimestampMargin
    /// @param _requestTimestampMargin new requestTimestampMargin value
    function setRequestTimestampMargin(
        uint256 _requestTimestampMargin
    ) external onlyRole(REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE) {
        LimitsListValidator.checkLimitValue(_requestTimestampMargin, 0, type(uint32).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.requestTimestampMargin = SafeCast.toUint32(_requestTimestampMargin);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new value for the maxItemsPerExtraDataTransaction
    /// @param _maxItemsPerExtraDataTransaction new maxItemsPerExtraDataTransaction value
    function setMaxItemsPerExtraDataTransaction(
        uint256 _maxItemsPerExtraDataTransaction
    ) external onlyRole(MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE) {
        LimitsListValidator.checkLimitValue(_maxItemsPerExtraDataTransaction, 0, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxItemsPerExtraDataTransaction = SafeCast.toUint16(_maxItemsPerExtraDataTransaction);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the new value for the max maxNodeOperatorsPerExtraDataItem
    /// @param _maxNodeOperatorsPerExtraDataItem new maxNodeOperatorsPerExtraDataItem value
    function setMaxNodeOperatorsPerExtraDataItem(
        uint256 _maxNodeOperatorsPerExtraDataItem
    ) external onlyRole(MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE) {
        LimitsListValidator.checkLimitValue(_maxNodeOperatorsPerExtraDataItem, 0, type(uint16).max);
        OperationalLimitsPacked memory limits = _operationalLimits;
        limits.maxNodeOperatorsPerExtraDataItem = SafeCast.toUint16(_maxNodeOperatorsPerExtraDataItem);
        _updateOperationalLimits(limits);
    }

    /// @notice Sets the address of the second opinion oracle.
    /// @param _secondOpinionOracle second opinion oracle.
    ///     If it's zero address — oracle is disabled.
    function setSecondOpinionOracle(
        ISecondOpinionOracle _secondOpinionOracle
    ) external onlyRole(SECOND_OPINION_MANAGER_ROLE) {
        if (_secondOpinionOracle != secondOpinionOracle) {
            secondOpinionOracle = _secondOpinionOracle;
            emit SecondOpinionOracleChanged(_secondOpinionOracle);
        }
    }

    /// @notice Sets the limits for a negative CL accounting rebase: the soft per-report limit,
    ///     the hard limit per day of elapsed time, and the absolute per-report ceiling of the hard limit.
    function setCLRebaseDecreaseBPLimits(
        uint256 _softLimitBP,
        uint256 _dailyHardLimitBP,
        uint256 _hardLimitBP
    ) external onlyRole(CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE) {
        LimitsListValidator.checkLimitValue(_hardLimitBP, 0, MAX_BASIS_POINTS);
        LimitsListValidator.checkLimitValue(_dailyHardLimitBP, 0, _hardLimitBP);
        LimitsListValidator.checkLimitValue(_softLimitBP, 0, _dailyHardLimitBP);
        AccountingCoreLimitsPacked memory limits = _accountingCoreLimits;
        limits.clRebaseDecreaseSoftBPLimit = LimitsListPacker.toBasisPoints(_softLimitBP);
        limits.dailyCLRebaseDecreaseHardBPLimit = LimitsListPacker.toBasisPoints(_dailyHardLimitBP);
        limits.clRebaseDecreaseHardBPLimit = LimitsListPacker.toBasisPoints(_hardLimitBP);
        _updateAccountingCoreLimits(limits);
    }

    /// @notice Applies sanity checks to the accounting params of Lido's oracle report.
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
    function checkAccountingOracleReport(
        uint256 _timeElapsed,
        uint256 _preCLValidatorsBalance,
        uint256 _preCLPendingBalance,
        uint256 _postCLValidatorsBalance,
        uint256 _postCLPendingBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _deposits
    ) external view {
        if (msg.sender != ACCOUNTING_ADDRESS) {
            revert CalledNotFromAccounting();
        }
        // 1. Withdrawals vault reported balance
        _checkWithdrawalVaultBalance(LIDO_LOCATOR.withdrawalVault().balance, _withdrawalVaultBalance);
        // 2. EL rewards vault reported balance
        _checkELRewardsVaultBalance(LIDO_LOCATOR.elRewardsVault().balance, _elRewardsVaultBalance);
        // 3. Burn requests
        _checkSharesRequestedToBurn(_sharesRequestedToBurn);
        CLBalanceChangeCheckParams memory checkParams = CLBalanceChangeCheckParams({
            timeElapsed: _timeElapsed,
            preCLValidatorsBalance: _preCLValidatorsBalance,
            preCLPendingBalance: _preCLPendingBalance,
            postCLValidatorsBalance: _postCLValidatorsBalance,
            postCLPendingBalance: _postCLPendingBalance,
            deposits: _deposits
        });
        _checkAccountingOracleReportCLBalances(checkParams, _withdrawalVaultBalance);
    }

    /// @dev Classifies the aggregate CL accounting rebase into normal, second-opinion, and hard-revert ranges.
    function _checkAccountingOracleReportCLBalances(
        CLBalanceChangeCheckParams memory _checkParams,
        uint256 _withdrawalVaultBalance
    ) internal view {
        AccountingCoreLimitsPacked memory limitsList = _accountingCoreLimits;
        uint256 preCLBalance =
            _checkParams.preCLValidatorsBalance + _checkParams.preCLPendingBalance + _checkParams.deposits;
        uint256 postCLAccountingBalance =
            _checkParams.postCLValidatorsBalance + _checkParams.postCLPendingBalance + _withdrawalVaultBalance;

        bool requiresSecondOpinion;
        if (postCLAccountingBalance < preCLBalance) {
            requiresSecondOpinion = _classifyCLRebaseDecrease(
                limitsList,
                preCLBalance - postCLAccountingBalance,
                preCLBalance,
                _checkParams.timeElapsed
            );
        } else {
            requiresSecondOpinion = _classifyAnnualCLRebaseIncrease(
                limitsList,
                postCLAccountingBalance - preCLBalance,
                preCLBalance,
                _getTimeElapsedForAllowanceChecks(_checkParams.timeElapsed)
            );
        }

        if (requiresSecondOpinion) _checkSecondOpinionReportHash();
    }

    /// @notice Checks per-module validators balances consistency and their deterministic growth budget, all in wei.
    function checkModuleAndCLBalancesChangeRates(
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _validatorBalancesWeiByStakingModule,
        uint256 _preCLValidatorsBalanceWei,
        uint256 _preCLPendingBalanceWei,
        uint256 _postCLValidatorsBalanceWei,
        uint256 _postCLPendingBalanceWei,
        uint256 _depositsWei,
        uint256 _timeElapsed
    ) external view {
        CLBalanceChangeCheckParams memory checkParams = CLBalanceChangeCheckParams({
            timeElapsed: _timeElapsed,
            preCLValidatorsBalance: _preCLValidatorsBalanceWei,
            preCLPendingBalance: _preCLPendingBalanceWei,
            postCLValidatorsBalance: _postCLValidatorsBalanceWei,
            postCLPendingBalance: _postCLPendingBalanceWei,
            deposits: _depositsWei
        });
        _checkCLBalancesConsistency(
            _stakingModuleIdsWithUpdatedBalance,
            _validatorBalancesWeiByStakingModule,
            checkParams.postCLValidatorsBalance
        );

        _checkModuleValidatorsBalanceIncrease(
            IStakingRouter(LIDO_LOCATOR.stakingRouter()),
            _accountingCoreLimits,
            _stakingModuleIdsWithUpdatedBalance,
            _validatorBalancesWeiByStakingModule,
            checkParams
        );
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

    /// @notice Checks the newly exited validators count against the exited ETH amount per day limit.
    /// @dev The check converts newly exited validators to ETH using `exitedValidatorEthAmountLimit`,
    ///     normalizes the result by `_timeElapsed`, and compares it with the stored exited and
    ///     consolidation per-day limits. The stored limits are expressed in 16 ETH exit units and
    ///     are doubled before comparison.
    /// @param _newlyExitedValidatorsCount Number of newly exited validators since previous report.
    /// @param _timeElapsed Time elapsed in seconds since previous report.
    function checkExitedValidatorsCount(
        uint256 _newlyExitedValidatorsCount,
        uint256 _timeElapsed
    ) external view {
        AccountingCoreLimitsPacked memory limitsList = _accountingCoreLimits;
        uint256 newlyExitedValidatorsEthAmount =
            _newlyExitedValidatorsCount * uint256(limitsList.exitedValidatorEthAmountLimit) * 1 ether;
        uint256 newlyExitedValidatorsEthAmountPerDay =
            _normalizePerDay(newlyExitedValidatorsEthAmount, _timeElapsed);
        uint256 exitedEthAmountPerDayLimitWithConsolidation =
            (uint256(limitsList.exitedEthAmountPerDayLimit) + uint256(limitsList.consolidationEthAmountPerDayLimit)) *
            2 *
            1 ether;
        if (newlyExitedValidatorsEthAmountPerDay > exitedEthAmountPerDayLimitWithConsolidation) {
            revert ExitedEthAmountPerDayLimitExceeded(
                exitedEthAmountPerDayLimitWithConsolidation,
                newlyExitedValidatorsEthAmountPerDay
            );
        }
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
        uint256[] calldata _validatorBalancesWeiByStakingModule,
        uint256 _clValidatorsBalanceWei
    ) internal pure {
        uint256 modulesCount = _stakingModuleIdsWithUpdatedBalance.length;
        if (modulesCount != _validatorBalancesWeiByStakingModule.length) {
            revert InvalidClBalancesData();
        }

        uint256 validatorBalancesSum;
        for (uint256 i = 0; i < modulesCount;) {
            validatorBalancesSum += _validatorBalancesWeiByStakingModule[i];
            unchecked {
                ++i;
            }
        }

        if (validatorBalancesSum != _clValidatorsBalanceWei) {
            revert InconsistentValidatorsBalanceByModule(_clValidatorsBalanceWei, validatorBalancesSum);
        }
    }

    function _normalizePerDay(uint256 _amount, uint256 _timeElapsed) internal pure returns (uint256) {
        return (_amount * SECONDS_PER_DAY) / _getTimeElapsedForRateNormalization(_timeElapsed);
    }

    /// @dev Uses the smallest non-zero interval for zero elapsed time so rate checks
    ///      avoid division by zero without relaxing per-day limits.
    function _getTimeElapsedForRateNormalization(uint256 _timeElapsed) internal pure returns (uint256) {
        return _timeElapsed == 0 ? 1 : _timeElapsed;
    }

    /// @dev Allows scratch-deploy reports with zero elapsed time by giving allowance
    ///      checks a bounded one-hour effective window.
    function _getTimeElapsedForAllowanceChecks(uint256 _timeElapsed) internal pure returns (uint256) {
        return _timeElapsed == 0 ? DEFAULT_TIME_ELAPSED : _timeElapsed;
    }

    function _calculateAmountForPeriod(
        uint256 _amountPerDay,
        uint256 _effectiveTimeElapsed
    ) internal pure returns (uint256) {
        return (_amountPerDay * _effectiveTimeElapsed) / SECONDS_PER_DAY;
    }

    function _checkCLPendingBalanceAndCalculateMaxPossibleActivatedBalance(
        AccountingCoreLimitsPacked memory _limitsList,
        CLBalanceChangeCheckParams memory _checkParams
    ) internal pure returns (ActivationBalanceCheckResult memory result) {
        result.effectiveTimeElapsed = _getTimeElapsedForAllowanceChecks(_checkParams.timeElapsed);

        uint256 fundedPendingBalance = _checkParams.preCLPendingBalance + _checkParams.deposits;
        uint256 pendingBalanceCap = fundedPendingBalance + uint256(_limitsList.externalPendingBalanceCapEth) * 1 ether;
        if (_checkParams.postCLPendingBalance > pendingBalanceCap) {
            revert IncorrectTotalPendingBalance(pendingBalanceCap, _checkParams.postCLPendingBalance);
        }

        uint256 activatedBalance = fundedPendingBalance > _checkParams.postCLPendingBalance
            ? fundedPendingBalance - _checkParams.postCLPendingBalance
            : 0;

        uint256 appearedEthLimitPerPeriod = _calculateAmountForPeriod(
            uint256(_limitsList.appearedEthAmountPerDayLimit) * 1 ether,
            result.effectiveTimeElapsed
        );
        // When a large validator deposit reaches the CL pending queue, it is not processed in parts.
        // The churn limit is counted as up to 256 ETH per epoch, so a 2048 ETH deposit has to wait
        // for about 8 epochs and then moves to the CL validator balance as a whole.
        //
        // This check calculates the limit for the report period: 225 * 256 = 57_600 ETH per day.
        // If the previous report lands after epoch 7, this frame can observe the whole 2048 ETH jump.
        // That means we expect linear growth over the period, while the observed pending delta can
        // be bursty. The burst capacity is bounded by the max possible validator size.
        uint256 activatedBalanceLimit = appearedEthLimitPerPeriod + MAX_VALIDATOR_EFFECTIVE_BALANCE;
        if (activatedBalance > activatedBalanceLimit) {
            revert IncorrectTotalActivatedBalance(activatedBalanceLimit, activatedBalance);
        }

        result.maxPossibleActivatedBalance =
            activatedBalance +
            _calculateAnnualCLRebaseIncreaseLimit(
                _checkParams.preCLValidatorsBalance + activatedBalance,
                _limitsList.annualCLRebaseIncreaseSoftBPLimit,
                result.effectiveTimeElapsed
            );
    }

    function _checkModuleValidatorsBalanceIncrease(
        IStakingRouter _stakingRouter,
        AccountingCoreLimitsPacked memory _limitsList,
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _validatorBalancesWeiByStakingModule,
        CLBalanceChangeCheckParams memory _checkParams
    ) internal view {
        ActivationBalanceCheckResult memory activationCheckResult =
            _checkCLPendingBalanceAndCalculateMaxPossibleActivatedBalance(_limitsList, _checkParams);

        uint256 grossPositiveModuleDeltas = _calculateGrossPositiveModuleDeltas(
            _stakingRouter,
            _stakingModuleIdsWithUpdatedBalance,
            _validatorBalancesWeiByStakingModule
        );

        uint256 consolidationLimitPerPeriodWei = _calculateAmountForPeriod(
            uint256(_limitsList.consolidationEthAmountPerDayLimit) * 1 ether,
            activationCheckResult.effectiveTimeElapsed
        );
        // Positive module deltas include validator activations and ordinary CL rewards.
        // Consolidations may move additional balance between modules, so their throughput
        // allowance is added separately.
        uint256 totalPositiveModuleDeltasLimit =
            activationCheckResult.maxPossibleActivatedBalance + consolidationLimitPerPeriodWei;
        if (grossPositiveModuleDeltas > totalPositiveModuleDeltasLimit) {
            revert IncorrectTotalModuleValidatorsBalanceIncrease(
                totalPositiveModuleDeltasLimit,
                grossPositiveModuleDeltas
            );
        }
    }

    function _calculateGrossPositiveModuleDeltas(
        IStakingRouter _stakingRouter,
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _validatorBalancesWeiByStakingModule
    ) internal view returns (uint256 grossPositiveModuleDeltas) {
        uint256 modulesCount = _stakingModuleIdsWithUpdatedBalance.length;
        for (uint256 i = 0; i < modulesCount;) {
            (bool hasPreviousAccounting, uint64 previousModuleValidatorsBalanceGwei,) =
                _getModuleAccountingState(_stakingRouter, _stakingModuleIdsWithUpdatedBalance[i]);
            uint256 previousModuleValidatorsBalanceWei = uint256(previousModuleValidatorsBalanceGwei) * 1 gwei;
            // Skip module-delta aggregation until the module has previous accounting baseline.
            if (hasPreviousAccounting && _validatorBalancesWeiByStakingModule[i] > previousModuleValidatorsBalanceWei) {
                grossPositiveModuleDeltas +=
                    _validatorBalancesWeiByStakingModule[i] - previousModuleValidatorsBalanceWei;
            }

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Returns stored module accounting state and whether it can be used as previous baseline in sanity checks.
    /// @dev All modules existing at release activation get their initial accounting baseline via StakingRouter migration.
    /// @dev Modules added after the release have no previous baseline in the first report, so module-delta
    ///      aggregation is skipped for them until `reportValidatorBalancesByStakingModule(...)` seeds their accounting state.
    /// @param _stakingRouter StakingRouter contract used as the source of module accounting state.
    /// @param _moduleId Staking module id.
    /// @return hasPreviousAccounting True if previous accounting baseline is available for sanity checks.
    /// @return previousValidatorsBalanceGwei Previous module validators balance in gwei.
    /// @return exitedValidatorsCount Previous module exited validators count.
    function _getModuleAccountingState(
        IStakingRouter _stakingRouter,
        uint256 _moduleId
    )
        internal
        view
        returns (
            bool hasPreviousAccounting,
            uint64 previousValidatorsBalanceGwei,
            uint64 exitedValidatorsCount
        )
    {
        (previousValidatorsBalanceGwei, exitedValidatorsCount) =
            _stakingRouter.getStakingModuleStateAccounting(_moduleId);
        hasPreviousAccounting =
            previousValidatorsBalanceGwei != 0 ||
            exitedValidatorsCount != 0;
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

    function _classifyCLRebaseDecrease(
        AccountingCoreLimitsPacked memory _limitsList,
        uint256 _clRebaseDecrease,
        uint256 _preCLBalance,
        uint256 _timeElapsed
    ) internal pure returns (bool requiresSecondOpinion) {
        uint256 hardLimit = _calculateCLRebaseDecreaseHardLimit(_limitsList, _preCLBalance, _timeElapsed);
        if (_clRebaseDecrease > hardLimit) {
            revert CLRebaseDecreaseAboveHardLimit(_clRebaseDecrease, hardLimit);
        }

        uint256 softLimit =
            _preCLBalance * uint256(_limitsList.clRebaseDecreaseSoftBPLimit) / MAX_BASIS_POINTS;
        return _clRebaseDecrease > softLimit;
    }

    /// @dev The hard limit grows with the time elapsed since the previous report, counted as at least one day,
    ///      so a missed report does not turn a correct decrease into a revert. The per-report ceiling bounds it.
    function _calculateCLRebaseDecreaseHardLimit(
        AccountingCoreLimitsPacked memory _limitsList,
        uint256 _preCLBalance,
        uint256 _timeElapsed
    ) internal pure returns (uint256) {
        uint256 limitForElapsedTime = (_preCLBalance *
            uint256(_limitsList.dailyCLRebaseDecreaseHardBPLimit) *
            Math256.max(_timeElapsed, SECONDS_PER_DAY)) / (MAX_BASIS_POINTS * SECONDS_PER_DAY);
        uint256 limitPerReport = (_preCLBalance * uint256(_limitsList.clRebaseDecreaseHardBPLimit)) / MAX_BASIS_POINTS;
        return Math256.min(limitForElapsedTime, limitPerReport);
    }

    function _classifyAnnualCLRebaseIncrease(
        AccountingCoreLimitsPacked memory _limitsList,
        uint256 _clRebaseIncrease,
        uint256 _preCLBalance,
        uint256 _effectiveTimeElapsed
    ) internal pure returns (bool requiresSecondOpinion) {
        uint256 hardLimit = _calculateAnnualCLRebaseIncreaseLimit(
            _preCLBalance,
            _limitsList.annualCLRebaseIncreaseHardBPLimit,
            _effectiveTimeElapsed
        );
        if (_clRebaseIncrease > hardLimit) {
            revert AnnualCLRebaseIncreaseAboveHardLimit(_clRebaseIncrease, hardLimit);
        }

        uint256 softLimit = _calculateAnnualCLRebaseIncreaseLimit(
            _preCLBalance,
            _limitsList.annualCLRebaseIncreaseSoftBPLimit,
            _effectiveTimeElapsed
        );
        return _clRebaseIncrease > softLimit;
    }

    function _calculateAnnualCLRebaseIncreaseLimit(
        uint256 _preCLBalance,
        uint256 _annualLimitBP,
        uint256 _effectiveTimeElapsed
    ) internal pure returns (uint256) {
        uint256 effectivePreCLBalance = _preCLBalance == 0 ? DEFAULT_CL_BALANCE : _preCLBalance;
        return
            effectivePreCLBalance * _annualLimitBP * _effectiveTimeElapsed / ANNUAL_BALANCE_INCREASE_DENOMINATOR;
    }

    function _checkSecondOpinionReportHash() internal view {
        // slither-disable-next-line unused-return
        (bytes32 consensusReportHash, uint256 refSlot,, bool processingStarted) =
            IBaseOracle(LIDO_LOCATOR.accountingOracle()).getConsensusReport();
        if (!processingStarted) revert ConsensusReportNotProcessing(refSlot);
        if (address(secondOpinionOracle) == address(0)) revert SecondOpinionReportNotReady(refSlot);

        (bool exists, bytes32 attestedReportHash) = secondOpinionOracle.getReportHash(refSlot);
        if (!exists) revert SecondOpinionReportNotReady(refSlot);

        if (attestedReportHash != consensusReportHash) {
            revert SecondOpinionReportHashMismatch(refSlot, consensusReportHash, attestedReportHash);
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
        uint256 simulatedShareDiff = Math256.absDiff(actualShareRate, _simulatedShareRate);
        uint256 simulatedShareDeviation = (MAX_BASIS_POINTS * simulatedShareDiff) / actualShareRate;

        if (simulatedShareDeviation > _limitsList.simulatedShareRateDeviationBPLimit) {
            revert IncorrectSimulatedShareRate(_simulatedShareRate, actualShareRate);
        }
    }

    function _updateLimits(LimitsList memory _newLimitsList) internal {
        LimitsListValidator.validate(_newLimitsList);
        _updateAccountingCoreLimits(_newLimitsList.packAccountingCore());
        _updateOperationalLimits(_newLimitsList.packOperational());
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
        if (_oldLimits.externalPendingBalanceCapEth != _newLimits.externalPendingBalanceCapEth) {
            emit ExternalPendingBalanceCapEthSet(_newLimits.externalPendingBalanceCapEth);
        }
        if (
            _oldLimits.annualCLRebaseIncreaseSoftBPLimit != _newLimits.annualCLRebaseIncreaseSoftBPLimit ||
            _oldLimits.annualCLRebaseIncreaseHardBPLimit != _newLimits.annualCLRebaseIncreaseHardBPLimit
        ) {
            emit AnnualCLRebaseIncreaseBPLimitsSet(
                _newLimits.annualCLRebaseIncreaseSoftBPLimit,
                _newLimits.annualCLRebaseIncreaseHardBPLimit
            );
        }
        if (_oldLimits.simulatedShareRateDeviationBPLimit != _newLimits.simulatedShareRateDeviationBPLimit) {
            emit SimulatedShareRateDeviationBPLimitSet(_newLimits.simulatedShareRateDeviationBPLimit);
        }
        if (
            _oldLimits.clRebaseDecreaseSoftBPLimit != _newLimits.clRebaseDecreaseSoftBPLimit ||
            _oldLimits.dailyCLRebaseDecreaseHardBPLimit != _newLimits.dailyCLRebaseDecreaseHardBPLimit ||
            _oldLimits.clRebaseDecreaseHardBPLimit != _newLimits.clRebaseDecreaseHardBPLimit
        ) {
            emit CLRebaseDecreaseBPLimitsSet(
                _newLimits.clRebaseDecreaseSoftBPLimit,
                _newLimits.dailyCLRebaseDecreaseHardBPLimit,
                _newLimits.clRebaseDecreaseHardBPLimit
            );
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
    event ExternalPendingBalanceCapEthSet(uint256 externalPendingBalanceCapEth);
    event SecondOpinionOracleChanged(ISecondOpinionOracle indexed secondOpinionOracle);
    event AnnualCLRebaseIncreaseBPLimitsSet(uint256 softLimitBP, uint256 hardLimitBP);
    event SimulatedShareRateDeviationBPLimitSet(uint256 simulatedShareRateDeviationBPLimit);
    event MaxBalanceExitRequestedPerReportInEthSet(uint256 maxBalanceExitRequestedPerReportInEth);
    event MaxEffectiveBalanceWeightWCType01Set(uint256 maxEffectiveBalanceWeightWCType01);
    event MaxEffectiveBalanceWeightWCType02Set(uint256 maxEffectiveBalanceWeightWCType02);
    event MaxItemsPerExtraDataTransactionSet(uint256 maxItemsPerExtraDataTransaction);
    event MaxNodeOperatorsPerExtraDataItemSet(uint256 maxNodeOperatorsPerExtraDataItem);
    event RequestTimestampMarginSet(uint256 requestTimestampMargin);
    event CLRebaseDecreaseBPLimitsSet(uint256 softLimitBP, uint256 dailyHardLimitBP, uint256 hardLimitBP);

    error IncorrectWithdrawalsVaultBalance(uint256 actualWithdrawalVaultBalance);
    error IncorrectELRewardsVaultBalance(uint256 actualELRewardsVaultBalance);
    error IncorrectSharesRequestedToBurn(uint256 actualSharesToBurn);
    error InvalidClBalancesData();
    error InconsistentValidatorsBalanceByModule(uint256 expected, uint256 actual);
    error IncorrectTotalPendingBalance(uint256 maxAllowed, uint256 actual);
    error IncorrectTotalActivatedBalance(uint256 maxAllowed, uint256 actual);
    error IncorrectTotalModuleValidatorsBalanceIncrease(uint256 maxAllowed, uint256 actual);
    error IncorrectSumOfExitBalancePerReport(uint256 maxBalanceSum);
    error IncorrectRequestFinalization(uint256 requestCreationTimestamp);
    error IncorrectSimulatedShareRate(uint256 simulatedShareRate, uint256 actualShareRate);
    error TooManyItemsPerExtraDataTransaction(uint256 maxItemsCount, uint256 receivedItemsCount);
    error ExitedEthAmountPerDayLimitExceeded(uint256 limitPerDay, uint256 exitedPerDay);
    error TooManyNodeOpsPerExtraDataItem(uint256 itemIndex, uint256 nodeOpsCount);
    error AdminCannotBeZero();

    error CLRebaseDecreaseAboveHardLimit(uint256 decrease, uint256 hardLimit);
    error AnnualCLRebaseIncreaseAboveHardLimit(uint256 increase, uint256 hardLimit);
    error ConsensusReportNotProcessing(uint256 refSlot);
    error SecondOpinionReportNotReady(uint256 refSlot);
    error SecondOpinionReportHashMismatch(uint256 refSlot, bytes32 consensusHash, bytes32 attestedHash);
    error CalledNotFromAccounting();
}
