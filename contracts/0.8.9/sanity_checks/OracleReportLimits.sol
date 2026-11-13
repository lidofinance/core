// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable one-contract-per-file
pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

uint256 constant MAX_BASIS_POINTS = 10_000;

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
    /// @notice The soft annualized limit for a positive CL accounting rebase.
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 annualCLRebaseIncreaseSoftBPLimit;

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
    /// @notice The hard annualized limit for a positive CL accounting rebase.
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 annualCLRebaseIncreaseHardBPLimit;
    /// @notice The soft per-report limit for a negative CL accounting rebase.
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 clRebaseDecreaseSoftBPLimit;
    /// @notice The absolute per-report ceiling of the hard limit for a negative CL accounting rebase.
    /// @dev Represented in the Basis Points (100% == 10_000)
    uint256 clRebaseDecreaseHardBPLimit;
    /// @notice The max possible consolidation ETH amount that might be reported
    ///     per single day.
    /// @dev Must fit into uint32 (<= 4_294_967_295)
    uint256 consolidationEthAmountPerDayLimit;
    /// @notice Effective ETH amount attributed to a single exited validator
    ///     in the exited ETH amount per day check.
    /// @dev Stored in whole ETH units. Must fit into uint16.
    uint256 exitedValidatorEthAmountLimit;
    /// @notice Extra protocol-level pending balance cap to tolerate bounded side deposits
    ///     or same-validator top-ups that were not funded by Lido.
    /// @dev Stored in whole ETH units. Must fit into uint16.
    uint256 externalPendingBalanceCapEth;
    /// @notice The hard limit for a negative CL accounting rebase per day of time elapsed since the previous report.
    /// @dev Represented in the Basis Points (100% == 10_000). The elapsed time counts as at least one day,
    ///     and the result is capped by `clRebaseDecreaseHardBPLimit`.
    uint256 dailyCLRebaseDecreaseHardBPLimit;
}

/// @dev The packed accounting/rebase limits persisted in a single storage slot
struct AccountingCoreLimitsPacked {
    uint32 exitedEthAmountPerDayLimit;
    uint32 appearedEthAmountPerDayLimit;
    uint32 consolidationEthAmountPerDayLimit;
    uint16 annualCLRebaseIncreaseSoftBPLimit;
    uint16 simulatedShareRateDeviationBPLimit;
    uint16 annualCLRebaseIncreaseHardBPLimit;
    uint16 clRebaseDecreaseSoftBPLimit;
    uint16 clRebaseDecreaseHardBPLimit;
    uint16 exitedValidatorEthAmountLimit;
    uint16 externalPendingBalanceCapEth;
    uint16 dailyCLRebaseDecreaseHardBPLimit;
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

library LimitsListPacker {
    error BasisPointsOverflow(uint256 value, uint256 maxValue);

    function packAccountingCore(
        LimitsList memory _limitsList
    ) internal pure returns (AccountingCoreLimitsPacked memory res) {
        res.exitedEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.exitedEthAmountPerDayLimit);
        res.appearedEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.appearedEthAmountPerDayLimit);
        res.consolidationEthAmountPerDayLimit = SafeCast.toUint32(_limitsList.consolidationEthAmountPerDayLimit);
        res.annualCLRebaseIncreaseSoftBPLimit = toBasisPoints(_limitsList.annualCLRebaseIncreaseSoftBPLimit);
        res.simulatedShareRateDeviationBPLimit = toBasisPoints(_limitsList.simulatedShareRateDeviationBPLimit);
        res.annualCLRebaseIncreaseHardBPLimit = toBasisPoints(_limitsList.annualCLRebaseIncreaseHardBPLimit);
        res.clRebaseDecreaseSoftBPLimit = toBasisPoints(_limitsList.clRebaseDecreaseSoftBPLimit);
        res.clRebaseDecreaseHardBPLimit = toBasisPoints(_limitsList.clRebaseDecreaseHardBPLimit);
        res.exitedValidatorEthAmountLimit = SafeCast.toUint16(_limitsList.exitedValidatorEthAmountLimit);
        res.externalPendingBalanceCapEth = SafeCast.toUint16(_limitsList.externalPendingBalanceCapEth);
        res.dailyCLRebaseDecreaseHardBPLimit = toBasisPoints(_limitsList.dailyCLRebaseDecreaseHardBPLimit);
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
        res.annualCLRebaseIncreaseSoftBPLimit = _accountingLimits.annualCLRebaseIncreaseSoftBPLimit;
        res.simulatedShareRateDeviationBPLimit = _accountingLimits.simulatedShareRateDeviationBPLimit;
        res.maxBalanceExitRequestedPerReportInEth = _operationalLimitsPacked.maxBalanceExitRequestedPerReportInEth;
        res.maxEffectiveBalanceWeightWCType01 = _operationalLimitsPacked.maxEffectiveBalanceWeightWCType01;
        res.maxEffectiveBalanceWeightWCType02 = _operationalLimitsPacked.maxEffectiveBalanceWeightWCType02;
        res.maxItemsPerExtraDataTransaction = _operationalLimitsPacked.maxItemsPerExtraDataTransaction;
        res.maxNodeOperatorsPerExtraDataItem = _operationalLimitsPacked.maxNodeOperatorsPerExtraDataItem;
        res.requestTimestampMargin = _operationalLimitsPacked.requestTimestampMargin;
        res.annualCLRebaseIncreaseHardBPLimit = _accountingLimits.annualCLRebaseIncreaseHardBPLimit;
        res.clRebaseDecreaseSoftBPLimit = _accountingLimits.clRebaseDecreaseSoftBPLimit;
        res.clRebaseDecreaseHardBPLimit = _accountingLimits.clRebaseDecreaseHardBPLimit;
        res.consolidationEthAmountPerDayLimit = _accountingLimits.consolidationEthAmountPerDayLimit;
        res.exitedValidatorEthAmountLimit = _accountingLimits.exitedValidatorEthAmountLimit;
        res.externalPendingBalanceCapEth = _accountingLimits.externalPendingBalanceCapEth;
        res.dailyCLRebaseDecreaseHardBPLimit = _accountingLimits.dailyCLRebaseDecreaseHardBPLimit;
    }
}

library LimitsListValidator {
    error IncorrectLimitValue(uint256 value, uint256 minAllowedValue, uint256 maxAllowedValue);

    function checkLimitValue(uint256 _value, uint256 _minAllowedValue, uint256 _maxAllowedValue) internal pure {
        if (_value > _maxAllowedValue || _value < _minAllowedValue) {
            revert IncorrectLimitValue(_value, _minAllowedValue, _maxAllowedValue);
        }
    }

    function validate(LimitsList memory _limitsList) internal pure {
        checkLimitValue(_limitsList.exitedEthAmountPerDayLimit, 0, type(uint32).max);
        checkLimitValue(_limitsList.appearedEthAmountPerDayLimit, 0, type(uint32).max);
        checkLimitValue(_limitsList.consolidationEthAmountPerDayLimit, 0, type(uint32).max);
        checkLimitValue(_limitsList.exitedValidatorEthAmountLimit, 1, type(uint16).max);
        checkLimitValue(_limitsList.externalPendingBalanceCapEth, 0, type(uint16).max);
        checkLimitValue(_limitsList.annualCLRebaseIncreaseHardBPLimit, 0, MAX_BASIS_POINTS);
        checkLimitValue(
            _limitsList.annualCLRebaseIncreaseSoftBPLimit,
            0,
            _limitsList.annualCLRebaseIncreaseHardBPLimit
        );
        checkLimitValue(_limitsList.simulatedShareRateDeviationBPLimit, 0, MAX_BASIS_POINTS);
        checkLimitValue(_limitsList.maxBalanceExitRequestedPerReportInEth, 0, type(uint16).max);
        checkLimitValue(_limitsList.maxEffectiveBalanceWeightWCType01, 1, type(uint16).max);
        checkLimitValue(_limitsList.maxEffectiveBalanceWeightWCType02, 1, type(uint16).max);
        checkLimitValue(_limitsList.maxItemsPerExtraDataTransaction, 0, type(uint16).max);
        checkLimitValue(_limitsList.maxNodeOperatorsPerExtraDataItem, 0, type(uint16).max);
        checkLimitValue(_limitsList.requestTimestampMargin, 0, type(uint32).max);
        checkLimitValue(_limitsList.clRebaseDecreaseHardBPLimit, 0, MAX_BASIS_POINTS);
        checkLimitValue(
            _limitsList.dailyCLRebaseDecreaseHardBPLimit,
            0,
            _limitsList.clRebaseDecreaseHardBPLimit
        );
        checkLimitValue(
            _limitsList.clRebaseDecreaseSoftBPLimit,
            0,
            _limitsList.dailyCLRebaseDecreaseHardBPLimit
        );
    }
}
