// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.9;

import {
    OracleReportSanityChecker,
    LimitsList,
    CLBalanceChangeCheckParams,
    AccountingCoreLimitsPacked,
    OperationalLimitsPacked,
    LimitsListPacker,
    LimitsListUnpacker
} from "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";

contract OracleReportSanityCheckerWrapper is OracleReportSanityChecker {
    using LimitsListPacker for LimitsList;
    using LimitsListUnpacker for AccountingCoreLimitsPacked;

    // Test-only storage for codec roundtrip checks; these are not the parent's private slots.
    AccountingCoreLimitsPacked private _accountingCoreLimitsPacked;
    OperationalLimitsPacked private _operationalLimitsPacked;

    constructor(
        address _lidoLocator,
        address _accounting,
        address _admin,
        LimitsList memory _limitsList,
        bool _postMigrationFirstReportDone
    ) OracleReportSanityChecker(_lidoLocator, _accounting, _admin, _limitsList) {
        if (_postMigrationFirstReportDone) {
            _finalizePostReportState(0, 0);
        }
    }

    function addReportData(uint256 _timestamp, uint256 _clBalance, uint256 _deposits, uint256 _clWithdrawals) public {
        _addReportData(_timestamp, _clBalance, _deposits, _clWithdrawals);
    }

    function harness__checkCLPendingBalanceIncrease(
        uint256 _timeElapsed,
        uint256 _preCLValidatorsBalance,
        uint256 _preCLPendingBalance,
        uint256 _postCLValidatorsBalance,
        uint256 _postCLPendingBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _deposits
    ) external view {
        CLBalanceChangeCheckParams memory checkParams = CLBalanceChangeCheckParams({
            timeElapsed: _timeElapsed,
            preCLValidatorsBalance: _preCLValidatorsBalance,
            preCLPendingBalance: _preCLPendingBalance,
            postCLValidatorsBalance: _postCLValidatorsBalance,
            postCLPendingBalance: _postCLPendingBalance,
            deposits: _deposits
        });
        _checkCLPendingBalanceIncrease(
            getOracleReportLimits().packAccountingCore(),
            checkParams,
            _getCLWithdrawals(_withdrawalVaultBalance)
        );
    }

    function harness__checkCLBalancesConsistency(
        uint256[] calldata _stakingModuleIdsWithUpdatedBalance,
        uint256[] calldata _validatorBalancesWeiByStakingModule,
        uint256 _clValidatorsBalanceWei
    ) external pure {
        _checkCLBalancesConsistency(
            _stakingModuleIdsWithUpdatedBalance,
            _validatorBalancesWeiByStakingModule,
            _clValidatorsBalanceWei
        );
    }

    function exposeAccountingCorePackedLimits() public view returns (AccountingCoreLimitsPacked memory) {
        return _accountingCoreLimitsPacked;
    }

    function exposeOperationalPackedLimits() public view returns (OperationalLimitsPacked memory) {
        return _operationalLimitsPacked;
    }

    function packAndStore() public {
        LimitsList memory limits = getOracleReportLimits();
        _accountingCoreLimitsPacked = limits.packAccountingCore();
        _operationalLimitsPacked = limits.packOperational();
    }

    function packRawLimits(
        LimitsList memory _limitsList
    ) external pure returns (AccountingCoreLimitsPacked memory, OperationalLimitsPacked memory) {
        return (_limitsList.packAccountingCore(), _limitsList.packOperational());
    }

    function roundtripRawLimits(LimitsList memory _limitsList) external pure returns (LimitsList memory) {
        return _limitsList.packAccountingCore().unpack(_limitsList.packOperational());
    }
}
