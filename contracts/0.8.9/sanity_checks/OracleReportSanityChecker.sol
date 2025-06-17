// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import {Math256} from "contracts/common/lib/Math256.sol";
import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {PositiveTokenRebaseLimiter, TokenRebaseLimiterData} from "../lib/PositiveTokenRebaseLimiter.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IBurner} from "contracts/common/interfaces/IBurner.sol";

import {StakingRouter} from "../StakingRouter.sol";
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

    function getWithdrawalStatus(uint256[] calldata _requestIds)
        external
        view
        returns (WithdrawalRequestStatus[] memory statuses);
}

interface IBaseOracle {
    function SECONDS_PER_SLOT() external view returns (uint256);
    function GENESIS_TIME() external view returns (uint256);
    function getLastProcessingRefSlot() external view returns (uint256);
}

/// @notice The set of restrictions used in the sanity checks of the oracle report
/// @dev struct is loaded from the storage and stored in memory during the tx running
struct LimitsList {
    /// @notice The max possible number of validators that might be reported as `exited`
    ///     per single day, depends on the Consensus Layer churn limit
    /// @dev Must fit into uint16 (<= 65_535)
    uint256 exitedValidatorsPerDayLimit;

    /// @notice The max possible number of validators that might be reported as `appeared`
    ///     per single day, limited by the max daily deposits via DepositSecurityModule in practice
    ///     isn't limited by a consensus layer (because `appeared` includes `pending`, i.e., not `activated` yet)
    /// @dev Must fit into uint16 (<= 65_535)
    uint256 appearedValidatorsPerDayLimit;

    /// @notice The max annual increase of the total validators' balances on the Consensus Layer
    ///     since the previous oracle report
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 annualBalanceIncreaseBPLimit;

    /// @notice The max number of exit requests allowed in report to ValidatorsExitBusOracle
    uint256 maxValidatorExitRequestsPerReport;

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

    /// @notice Initial slashing amount per one validator to calculate initial slashing of the validators' balances on the Consensus Layer
    /// @dev Represented in the PWei (1^15 Wei). Must fit into uint16 (<= 65_535)
    uint256 initialSlashingAmountPWei;

    /// @notice Inactivity penalties amount per one validator to calculate penalties of the validators' balances on the Consensus Layer
    /// @dev Represented in the PWei (1^15 Wei). Must fit into uint16 (<= 65_535)
    uint256 inactivityPenaltiesAmountPWei;

    /// @notice The maximum percent on how Second Opinion Oracle reported value could be greater
    ///     than reported by the AccountingOracle. There is an assumption that second opinion oracle CL balance
    ///     can be greater as calculated for the withdrawal credentials.
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 clBalanceOraclesErrorUpperBPLimit;
}

/// @dev The packed version of the LimitsList struct to be effectively persisted in storage
struct LimitsListPacked {
    uint16 exitedValidatorsPerDayLimit;
    uint16 appearedValidatorsPerDayLimit;
    uint16 annualBalanceIncreaseBPLimit;
    uint16 simulatedShareRateDeviationBPLimit_deprecated;
    uint16 maxValidatorExitRequestsPerReport;
    uint16 maxItemsPerExtraDataTransaction;
    uint16 maxNodeOperatorsPerExtraDataItem;
    uint32 requestTimestampMargin;
    uint64 maxPositiveTokenRebase;
    uint16 initialSlashingAmountPWei;
    uint16 inactivityPenaltiesAmountPWei;
    uint16 clBalanceOraclesErrorUpperBPLimit;
}

struct ReportData {
    uint64 timestamp;
    uint64 totalExitedValidators;
    uint128 negativeCLRebaseWei;
}

uint256 constant MAX_BASIS_POINTS = 10_000;
uint256 constant SHARE_RATE_PRECISION_E27 = 1e27;
uint256 constant ONE_PWEI = 1e15;

/// @title Sanity checks for the Lido's oracle report
/// @notice The contracts contain methods to perform sanity checks of the Lido's oracle report
///     and lever methods for granular tuning of the params of the checks
contract OracleReportSanityChecker is AccessControlEnumerable {
    using LimitsListPacker for LimitsList;
    using LimitsListUnpacker for LimitsListPacked;
    using PositiveTokenRebaseLimiter for TokenRebaseLimiterData;

    bytes32 public constant ALL_LIMITS_MANAGER_ROLE = keccak256("ALL_LIMITS_MANAGER_ROLE");
    bytes32 public constant EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE =
        keccak256("ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE");
    bytes32 public constant SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE =
        keccak256("SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE");
    bytes32 public constant MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE =
        keccak256("MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE");
    bytes32 public constant MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE =
        keccak256("MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE");
    bytes32 public constant MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE =
        keccak256("MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE");
    bytes32 public constant REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE = keccak256("REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE");
    bytes32 public constant MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE =
        keccak256("MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE");
    bytes32 public constant SECOND_OPINION_MANAGER_ROLE =
        keccak256("SECOND_OPINION_MANAGER_ROLE");
    bytes32 public constant INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE =
        keccak256("INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE");

    uint256 private constant DEFAULT_TIME_ELAPSED = 1 hours;
    uint256 private constant DEFAULT_CL_BALANCE = 1 gwei;
    uint256 private constant SECONDS_PER_DAY = 24 * 60 * 60;

    ILidoLocator private immutable LIDO_LOCATOR;
    uint256 private immutable GENESIS_TIME;
    uint256 private immutable SECONDS_PER_SLOT;
    address private immutable ACCOUNTING_ADDRESS;

    LimitsListPacked private _limits;

    /// @dev Historical reports data
    ReportData[] public reportData;

    /// @dev The address of the second opinion oracle
    ISecondOpinionOracle public secondOpinionOracle;

    /// @param _lidoLocator address of the LidoLocator instance
    /// @param _accountingOracle address of the AccountingOracle instance
    /// @param _accounting address of the Accounting instance
    /// @param _admin address to grant DEFAULT_ADMIN_ROLE of the AccessControl contract
    /// @param _limitsList initial values to be set for the limits list
    constructor(
        address _lidoLocator,
        address _accountingOracle,
        address _accounting,
        address _admin,
        LimitsList memory _limitsList
    ) {
        if (_admin == address(0)) revert AdminCannotBeZero();
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);

        GENESIS_TIME = IBaseOracle(_accountingOracle).GENESIS_TIME();
        SECONDS_PER_SLOT = IBaseOracle(_accountingOracle).SECONDS_PER_SLOT();
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
    function setOracleReportLimits(LimitsList calldata _limitsList, ISecondOpinionOracle _secondOpinionOracle) external onlyRole(ALL_LIMITS_MANAGER_ROLE) {
        _updateLimits(_limitsList);
        if (_secondOpinionOracle != secondOpinionOracle) {
            secondOpinionOracle = _secondOpinionOracle;
            emit SecondOpinionOracleChanged(_secondOpinionOracle);
        }
    }

    /// @notice Sets the new value for the exitedValidatorsPerDayLimit
    ///
    /// NB: AccountingOracle reports validators as exited once they passed the `EXIT_EPOCH` on Consensus Layer
    ///     therefore, the value should be set in accordance to the consensus layer churn limit
    ///
    /// @param _exitedValidatorsPerDayLimit new exitedValidatorsPerDayLimit value
    function setExitedValidatorsPerDayLimit(uint256 _exitedValidatorsPerDayLimit)
        external
        onlyRole(EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.exitedValidatorsPerDayLimit = _exitedValidatorsPerDayLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the appearedValidatorsPerDayLimit
    ///
    /// NB: AccountingOracle reports validators as appeared once they become `pending`
    ///     (might be not `activated` yet). Thus, this limit should be high enough because consensus layer
    ///     has no intrinsic churn limit for the amount of `pending` validators (only for `activated` instead).
    ///     For Lido it depends on the amount of deposits that can be made via DepositSecurityModule daily.
    ///
    /// @param _appearedValidatorsPerDayLimit new appearedValidatorsPerDayLimit value
    function setAppearedValidatorsPerDayLimit(uint256 _appearedValidatorsPerDayLimit)
        external
        onlyRole(APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.appearedValidatorsPerDayLimit = _appearedValidatorsPerDayLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the annualBalanceIncreaseBPLimit
    /// @param _annualBalanceIncreaseBPLimit new annualBalanceIncreaseBPLimit value
    function setAnnualBalanceIncreaseBPLimit(uint256 _annualBalanceIncreaseBPLimit)
        external
        onlyRole(ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.annualBalanceIncreaseBPLimit = _annualBalanceIncreaseBPLimit;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the maxValidatorExitRequestsPerReport
    /// @param _maxValidatorExitRequestsPerReport new maxValidatorExitRequestsPerReport value
    function setMaxExitRequestsPerOracleReport(uint256 _maxValidatorExitRequestsPerReport)
        external
        onlyRole(MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxValidatorExitRequestsPerReport = _maxValidatorExitRequestsPerReport;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the requestTimestampMargin
    /// @param _requestTimestampMargin new requestTimestampMargin value
    function setRequestTimestampMargin(uint256 _requestTimestampMargin)
        external
        onlyRole(REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE)
    {
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
    function setMaxPositiveTokenRebase(uint256 _maxPositiveTokenRebase)
        external
        onlyRole(MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxPositiveTokenRebase = _maxPositiveTokenRebase;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the maxItemsPerExtraDataTransaction
    /// @param _maxItemsPerExtraDataTransaction new maxItemsPerExtraDataTransaction value
    function setMaxItemsPerExtraDataTransaction(uint256 _maxItemsPerExtraDataTransaction)
        external
        onlyRole(MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxItemsPerExtraDataTransaction = _maxItemsPerExtraDataTransaction;
        _updateLimits(limitsList);
    }

    /// @notice Sets the new value for the max maxNodeOperatorsPerExtraDataItem
    /// @param _maxNodeOperatorsPerExtraDataItem new maxNodeOperatorsPerExtraDataItem value
    function setMaxNodeOperatorsPerExtraDataItem(uint256 _maxNodeOperatorsPerExtraDataItem)
        external
        onlyRole(MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.maxNodeOperatorsPerExtraDataItem = _maxNodeOperatorsPerExtraDataItem;
        _updateLimits(limitsList);
    }

    /// @notice Sets the address of the second opinion oracle and clBalanceOraclesErrorUpperBPLimit value
    /// @param _secondOpinionOracle second opinion oracle.
    ///     If it's zero address — oracle is disabled.
    ///     Default value is zero address.
    /// @param _clBalanceOraclesErrorUpperBPLimit new clBalanceOraclesErrorUpperBPLimit value
    function setSecondOpinionOracleAndCLBalanceUpperMargin(ISecondOpinionOracle _secondOpinionOracle, uint256 _clBalanceOraclesErrorUpperBPLimit)
        external
        onlyRole(SECOND_OPINION_MANAGER_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.clBalanceOraclesErrorUpperBPLimit = _clBalanceOraclesErrorUpperBPLimit;
        _updateLimits(limitsList);
        if (_secondOpinionOracle != secondOpinionOracle) {
            secondOpinionOracle = ISecondOpinionOracle(_secondOpinionOracle);
            emit SecondOpinionOracleChanged(_secondOpinionOracle);
        }
    }

    /// @notice Sets the initial slashing and penalties Amountficients
    /// @param _initialSlashingAmountPWei - initial slashing Amountficient (in PWei)
    /// @param _inactivityPenaltiesAmountPWei - penalties Amountficient (in PWei)
    function setInitialSlashingAndPenaltiesAmount(uint256 _initialSlashingAmountPWei, uint256 _inactivityPenaltiesAmountPWei)
        external
        onlyRole(INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE)
    {
        LimitsList memory limitsList = _limits.unpack();
        limitsList.initialSlashingAmountPWei = _initialSlashingAmountPWei;
        limitsList.inactivityPenaltiesAmountPWei = _inactivityPenaltiesAmountPWei;
        _updateLimits(limitsList);
    }

    /// @notice Returns the allowed ETH amount that might be taken from the withdrawal vault and EL
    ///     rewards vault during Lido's oracle report processing
    /// @param _preTotalPooledEther total amount of ETH controlled by the protocol
    /// @param _preTotalShares total amount of minted stETH shares
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
        uint256 _preTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _etherToLockForWithdrawals,
        uint256 _newSharesToBurnForWithdrawals
    ) external view returns (
        uint256 withdrawals,
        uint256 elRewards,
        uint256 sharesFromWQToBurn,
        uint256 sharesToBurn
    ) {
        TokenRebaseLimiterData memory tokenRebaseLimiter = PositiveTokenRebaseLimiter.initLimiterState(
            getMaxPositiveTokenRebase(),
            _preTotalPooledEther,
            _preTotalShares
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
    ///          It's needed to keep information about exited validators counts and negative rebase values over time.
    ///          The function called from Lido contract that uses the 'old' Solidity version (0.4.24) and will do a correct
    ///          call to this method even it's declared as "view" in interface there.
    /// @param _timeElapsed time elapsed since the previous oracle report
    /// @param _preCLBalance sum of all Lido validators' balances on the Consensus Layer before the
    ///     current oracle report (NB: also include the initial balance of newly appeared validators)
    /// @param _postCLBalance sum of all Lido validators' balances on the Consensus Layer after the
    ///     current oracle report
    /// @param _withdrawalVaultBalance withdrawal vault balance on Execution Layer for the report reference slot
    /// @param _elRewardsVaultBalance el rewards vault balance on Execution Layer for the report reference slot
    /// @param _sharesRequestedToBurn shares requested to burn for the report reference slot
    /// @param _preCLValidators Lido-participating validators on the CL side before the current oracle report
    /// @param _postCLValidators Lido-participating validators on the CL side after the current oracle report
    function checkAccountingOracleReport(
        uint256 _timeElapsed,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _preCLValidators,
        uint256 _postCLValidators
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
        _checkCLBalanceDecrease(limitsList, _preCLBalance,
            _postCLBalance, _withdrawalVaultBalance, _postCLValidators, refSlot);

        // 5. Consensus Layer annual balances increase
        _checkAnnualBalancesIncrease(limitsList, _preCLBalance, _postCLBalance, _timeElapsed);

        // 6. Appeared validators increase
        if (_postCLValidators > _preCLValidators) {
            _checkAppearedValidatorsChurnLimit(limitsList, (_postCLValidators - _preCLValidators), _timeElapsed);
        }
    }

    /// @notice Applies sanity checks to the number of validator exit requests supplied to ValidatorExitBusOracle
    /// @param _exitRequestsCount Number of validator exit requests supplied per oracle report
    function checkExitBusOracleReport(uint256 _exitRequestsCount)
        external
        view
    {
        uint256 limit = _limits.unpack().maxValidatorExitRequestsPerReport;
        if (_exitRequestsCount > limit) {
            revert IncorrectNumberOfExitRequestsPerReport(limit);
        }
    }

    /// @notice Check rate of exited validators per day
    /// @param _exitedValidatorsCount Number of validator exited per oracle report
    function checkExitedValidatorsRatePerDay(uint256 _exitedValidatorsCount)
        external
        view
    {
        uint256 exitedValidatorsLimit = _limits.unpack().exitedValidatorsPerDayLimit;
        if (_exitedValidatorsCount > exitedValidatorsLimit) {
            revert ExitedValidatorsLimitExceeded(exitedValidatorsLimit, _exitedValidatorsCount);
        }
    }

    /// @notice check the number of node operators reported per extra data item in the accounting oracle report.
    /// @param _itemIndex Index of item in extra data
    /// @param _nodeOperatorsCount Number of validator exit requests supplied per oracle report
    function checkNodeOperatorsPerExtraDataItemCount(uint256 _itemIndex, uint256 _nodeOperatorsCount)
        external
        view
    {
        uint256 limit = _limits.unpack().maxNodeOperatorsPerExtraDataItem;
        if (_nodeOperatorsCount > limit) {
            revert TooManyNodeOpsPerExtraDataItem(_itemIndex, _nodeOperatorsCount);
        }
    }

    /// @notice Check the number of extra data list items per transaction in the accounting oracle report.
    /// @param _extraDataListItemsCount Number of items per single transaction in the accounting oracle report
    function checkExtraDataItemsCountPerTransaction(uint256 _extraDataListItemsCount)
        external
        view
    {
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
    )
        external
        view
    {
        LimitsList memory limitsList = _limits.unpack();
        address withdrawalQueue = LIDO_LOCATOR.withdrawalQueue();

        _checkLastFinalizableId(limitsList, withdrawalQueue, _lastFinalizableRequestId, _reportTimestamp);
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

    function _addReportData(uint256 _timestamp, uint256 _exitedValidatorsCount, uint256 _negativeCLRebase) internal {
        reportData.push(ReportData(
            SafeCast.toUint64(_timestamp),
            SafeCast.toUint64(_exitedValidatorsCount),
            SafeCast.toUint128(_negativeCLRebase)
        ));
    }

    function _sumNegativeRebasesNotOlderThan(uint256 _timestamp) internal view returns (uint256) {
        uint256 sum;
        for (int256 index = int256(reportData.length) - 1; index >= 0; index--) {
            if (reportData[uint256(index)].timestamp > SafeCast.toUint64(_timestamp)) {
                sum += reportData[uint256(index)].negativeCLRebaseWei;
            } else {
                break;
            }
        }
        return sum;
    }

    function _exitedValidatorsAtTimestamp(uint256 _timestamp) internal view returns (uint256) {
        for (int256 index = int256(reportData.length) - 1; index >= 0; index--) {
            if (reportData[uint256(index)].timestamp <= SafeCast.toUint64(_timestamp)) {
                return reportData[uint256(index)].totalExitedValidators;
            }
        }
        return 0;
    }

    function _checkCLBalanceDecrease(
        LimitsList memory _limitsList,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _postCLValidators,
        uint256 _refSlot
    ) internal {
        uint256 reportTimestamp = GENESIS_TIME + _refSlot * SECONDS_PER_SLOT;

        // Checking exitedValidators against StakingRouter
        StakingRouter stakingRouter = StakingRouter(payable(LIDO_LOCATOR.stakingRouter()));
        uint256[] memory ids = stakingRouter.getStakingModuleIds();

        uint256 stakingRouterExitedValidators;
        for (uint256 i = 0; i < ids.length; i++) {
            StakingRouter.StakingModule memory module = stakingRouter.getStakingModule(ids[i]);
            stakingRouterExitedValidators += module.exitedValidatorsCount;
        }

        if (_preCLBalance <= _postCLBalance + _withdrawalVaultBalance) {
            _addReportData(reportTimestamp, stakingRouterExitedValidators, 0);
            // If the CL balance is not decreased, we don't need to check anything here
            return;
        }
        _addReportData(reportTimestamp, stakingRouterExitedValidators, _preCLBalance - (_postCLBalance + _withdrawalVaultBalance));

        // NOTE. Values of 18 and 54 days are taken from spec. Check the details here
        // https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-23.md
        uint256 negativeCLRebaseSum = _sumNegativeRebasesNotOlderThan(reportTimestamp - 18 days);
        uint256 maxAllowedCLRebaseNegativeSum =
            _limitsList.initialSlashingAmountPWei * ONE_PWEI * (_postCLValidators - _exitedValidatorsAtTimestamp(reportTimestamp - 18 days)) +
            _limitsList.inactivityPenaltiesAmountPWei * ONE_PWEI * (_postCLValidators - _exitedValidatorsAtTimestamp(reportTimestamp - 54 days));

        if (negativeCLRebaseSum <= maxAllowedCLRebaseNegativeSum) {
            // If the rebase diff is less or equal max allowed sum, we accept the report
            emit NegativeCLRebaseAccepted(_refSlot, _postCLBalance + _withdrawalVaultBalance, negativeCLRebaseSum, maxAllowedCLRebaseNegativeSum);
            return;
        }

        // If there is no negative rebase oracle, then we don't need to check it's report
        if (address(secondOpinionOracle) == address(0)) {
            // If there is no oracle and the diff is more than limit, we revert
            revert IncorrectCLBalanceDecrease(negativeCLRebaseSum, maxAllowedCLRebaseNegativeSum);
        }
        _askSecondOpinion(_refSlot, _postCLBalance, _withdrawalVaultBalance, _limitsList);
    }

    function _askSecondOpinion(uint256 _refSlot, uint256 _postCLBalance, uint256 _withdrawalVaultBalance, LimitsList memory _limitsList) internal {
        (bool success, uint256 clOracleBalanceGwei, uint256 oracleWithdrawalVaultBalanceWei,,) = secondOpinionOracle.getReport(_refSlot);

        if (success) {
            uint256 clBalanceWei = clOracleBalanceGwei * 1 gwei;
            if (clBalanceWei < _postCLBalance) {
                revert NegativeRebaseFailedCLBalanceMismatch(_postCLBalance, clBalanceWei, _limitsList.clBalanceOraclesErrorUpperBPLimit);
            }
            if (MAX_BASIS_POINTS * (clBalanceWei - _postCLBalance) >
                _limitsList.clBalanceOraclesErrorUpperBPLimit * clBalanceWei) {
                revert NegativeRebaseFailedCLBalanceMismatch(_postCLBalance, clBalanceWei, _limitsList.clBalanceOraclesErrorUpperBPLimit);
            }
            if (oracleWithdrawalVaultBalanceWei != _withdrawalVaultBalance) {
                revert NegativeRebaseFailedWithdrawalVaultBalanceMismatch(_withdrawalVaultBalance, oracleWithdrawalVaultBalanceWei);
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
        uint256 annualBalanceIncrease = ((365 days * MAX_BASIS_POINTS * balanceIncrease) /
            _preCLBalance) /
            _timeElapsed;

        if (annualBalanceIncrease > _limitsList.annualBalanceIncreaseBPLimit) {
            revert IncorrectCLBalanceIncrease(annualBalanceIncrease);
        }
    }

    function _checkAppearedValidatorsChurnLimit(
        LimitsList memory _limitsList,
        uint256 _appearedValidators,
        uint256 _timeElapsed
    ) internal pure {
        if (_timeElapsed == 0) {
            _timeElapsed = DEFAULT_TIME_ELAPSED;
        }

        uint256 appearedLimit = (_limitsList.appearedValidatorsPerDayLimit * _timeElapsed) / SECONDS_PER_DAY;

        if (_appearedValidators > appearedLimit) revert IncorrectAppearedValidators(_appearedValidators);
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

    function _updateLimits(LimitsList memory _newLimitsList) internal {
        LimitsList memory _oldLimitsList = _limits.unpack();
        if (_oldLimitsList.exitedValidatorsPerDayLimit != _newLimitsList.exitedValidatorsPerDayLimit) {
            _checkLimitValue(_newLimitsList.exitedValidatorsPerDayLimit, 0, type(uint16).max);
            emit ExitedValidatorsPerDayLimitSet(_newLimitsList.exitedValidatorsPerDayLimit);
        }
        if (_oldLimitsList.appearedValidatorsPerDayLimit != _newLimitsList.appearedValidatorsPerDayLimit) {
            _checkLimitValue(_newLimitsList.appearedValidatorsPerDayLimit, 0, type(uint16).max);
            emit AppearedValidatorsPerDayLimitSet(_newLimitsList.appearedValidatorsPerDayLimit);
        }
        if (_oldLimitsList.annualBalanceIncreaseBPLimit != _newLimitsList.annualBalanceIncreaseBPLimit) {
            _checkLimitValue(_newLimitsList.annualBalanceIncreaseBPLimit, 0, MAX_BASIS_POINTS);
            emit AnnualBalanceIncreaseBPLimitSet(_newLimitsList.annualBalanceIncreaseBPLimit);
        }
        if (_oldLimitsList.maxValidatorExitRequestsPerReport != _newLimitsList.maxValidatorExitRequestsPerReport) {
            _checkLimitValue(_newLimitsList.maxValidatorExitRequestsPerReport, 0, type(uint16).max);
            emit MaxValidatorExitRequestsPerReportSet(_newLimitsList.maxValidatorExitRequestsPerReport);
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
        if (_oldLimitsList.initialSlashingAmountPWei != _newLimitsList.initialSlashingAmountPWei) {
            _checkLimitValue(_newLimitsList.initialSlashingAmountPWei, 0, type(uint16).max);
            emit InitialSlashingAmountSet(_newLimitsList.initialSlashingAmountPWei);
        }
        if (_oldLimitsList.inactivityPenaltiesAmountPWei != _newLimitsList.inactivityPenaltiesAmountPWei) {
            _checkLimitValue(_newLimitsList.inactivityPenaltiesAmountPWei, 0, type(uint16).max);
            emit InactivityPenaltiesAmountSet(_newLimitsList.inactivityPenaltiesAmountPWei);
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

    event ExitedValidatorsPerDayLimitSet(uint256 exitedValidatorsPerDayLimit);
    event AppearedValidatorsPerDayLimitSet(uint256 appearedValidatorsPerDayLimit);
    event SecondOpinionOracleChanged(ISecondOpinionOracle indexed secondOpinionOracle);
    event AnnualBalanceIncreaseBPLimitSet(uint256 annualBalanceIncreaseBPLimit);
    event MaxPositiveTokenRebaseSet(uint256 maxPositiveTokenRebase);
    event MaxValidatorExitRequestsPerReportSet(uint256 maxValidatorExitRequestsPerReport);
    event MaxItemsPerExtraDataTransactionSet(uint256 maxItemsPerExtraDataTransaction);
    event MaxNodeOperatorsPerExtraDataItemSet(uint256 maxNodeOperatorsPerExtraDataItem);
    event RequestTimestampMarginSet(uint256 requestTimestampMargin);
    event InitialSlashingAmountSet(uint256 initialSlashingAmountPWei);
    event InactivityPenaltiesAmountSet(uint256 inactivityPenaltiesAmountPWei);
    event CLBalanceOraclesErrorUpperBPLimitSet(uint256 clBalanceOraclesErrorUpperBPLimit);
    event NegativeCLRebaseConfirmed(uint256 refSlot, uint256 clBalanceWei, uint256 withdrawalVaultBalance);
    event NegativeCLRebaseAccepted(uint256 refSlot, uint256 clTotalBalance, uint256 clBalanceDecrease, uint256 maxAllowedCLRebaseNegativeSum);

    error IncorrectLimitValue(uint256 value, uint256 minAllowedValue, uint256 maxAllowedValue);
    error IncorrectWithdrawalsVaultBalance(uint256 actualWithdrawalVaultBalance);
    error IncorrectELRewardsVaultBalance(uint256 actualELRewardsVaultBalance);
    error IncorrectSharesRequestedToBurn(uint256 actualSharesToBurn);
    error IncorrectCLBalanceIncrease(uint256 annualBalanceDiff);
    error IncorrectAppearedValidators(uint256 appearedValidatorsLimit);
    error IncorrectNumberOfExitRequestsPerReport(uint256 maxRequestsCount);
    error IncorrectExitedValidators(uint256 exitedValidatorsLimit);
    error IncorrectRequestFinalization(uint256 requestCreationBlock);
    error ActualShareRateIsZero();
    error TooManyItemsPerExtraDataTransaction(uint256 maxItemsCount, uint256 receivedItemsCount);
    error ExitedValidatorsLimitExceeded(uint256 limitPerDay, uint256 exitedPerDay);
    error TooManyNodeOpsPerExtraDataItem(uint256 itemIndex, uint256 nodeOpsCount);
    error AdminCannotBeZero();

    error IncorrectCLBalanceDecrease(uint256 negativeCLRebaseSum, uint256 maxNegativeCLRebaseSum);
    error NegativeRebaseFailedCLBalanceMismatch(uint256 reportedValue, uint256 provedValue, uint256 limitBP);
    error NegativeRebaseFailedWithdrawalVaultBalanceMismatch(uint256 reportedValue, uint256 provedValue);
    error NegativeRebaseFailedSecondOpinionReportIsNotReady();
    error CalledNotFromAccounting();
}

library LimitsListPacker {
    error BasisPointsOverflow(uint256 value, uint256 maxValue);

    function pack(LimitsList memory _limitsList) internal pure returns (LimitsListPacked memory res) {
        res.exitedValidatorsPerDayLimit = SafeCast.toUint16(_limitsList.exitedValidatorsPerDayLimit);
        res.appearedValidatorsPerDayLimit = SafeCast.toUint16(_limitsList.appearedValidatorsPerDayLimit);
        res.annualBalanceIncreaseBPLimit = _toBasisPoints(_limitsList.annualBalanceIncreaseBPLimit);
        res.requestTimestampMargin = SafeCast.toUint32(_limitsList.requestTimestampMargin);
        res.maxPositiveTokenRebase = SafeCast.toUint64(_limitsList.maxPositiveTokenRebase);
        res.maxValidatorExitRequestsPerReport = SafeCast.toUint16(_limitsList.maxValidatorExitRequestsPerReport);
        res.maxItemsPerExtraDataTransaction = SafeCast.toUint16(_limitsList.maxItemsPerExtraDataTransaction);
        res.maxNodeOperatorsPerExtraDataItem = SafeCast.toUint16(_limitsList.maxNodeOperatorsPerExtraDataItem);
        res.initialSlashingAmountPWei = SafeCast.toUint16(_limitsList.initialSlashingAmountPWei);
        res.inactivityPenaltiesAmountPWei = SafeCast.toUint16(_limitsList.inactivityPenaltiesAmountPWei);
        res.clBalanceOraclesErrorUpperBPLimit = _toBasisPoints(_limitsList.clBalanceOraclesErrorUpperBPLimit);
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
        res.exitedValidatorsPerDayLimit = _limitsList.exitedValidatorsPerDayLimit;
        res.appearedValidatorsPerDayLimit = _limitsList.appearedValidatorsPerDayLimit;
        res.annualBalanceIncreaseBPLimit = _limitsList.annualBalanceIncreaseBPLimit;
        res.requestTimestampMargin = _limitsList.requestTimestampMargin;
        res.maxPositiveTokenRebase = _limitsList.maxPositiveTokenRebase;
        res.maxValidatorExitRequestsPerReport = _limitsList.maxValidatorExitRequestsPerReport;
        res.maxItemsPerExtraDataTransaction = _limitsList.maxItemsPerExtraDataTransaction;
        res.maxNodeOperatorsPerExtraDataItem = _limitsList.maxNodeOperatorsPerExtraDataItem;
        res.initialSlashingAmountPWei = _limitsList.initialSlashingAmountPWei;
        res.inactivityPenaltiesAmountPWei = _limitsList.inactivityPenaltiesAmountPWei;
        res.clBalanceOraclesErrorUpperBPLimit = _limitsList.clBalanceOraclesErrorUpperBPLimit;
    }
}
