// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { IReportReceiver } from "../../oracle/AccountingOracle.sol";
import { ReportValues } from "../../Accounting.sol";
import { ILido } from "contracts/0.8.9/oracle/AccountingOracle.sol";

interface IPostTokenRebaseReceiver {
    function handlePostTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external;
}

contract MockLidoForAccountingOracle is IReportReceiver {
    address internal legacyOracle;

    struct HandleOracleReportLastCall {
        uint256 currentReportTimestamp;
        uint256 secondsElapsedSinceLastReport;
        uint256 numValidators;
        uint256 clBalance;
        uint256 withdrawalVaultBalance;
        uint256 elRewardsVaultBalance;
        uint256 sharesRequestedToBurn;
        uint256[] withdrawalFinalizationBatches;
        uint256 simulatedShareRate;
        uint256 callCount;
    }

    HandleOracleReportLastCall internal _handleOracleReportLastCall;

    function getLastCall_handleOracleReport()
        external
        view
        returns (HandleOracleReportLastCall memory)
    {
        return _handleOracleReportLastCall;
    }

    function setLegacyOracle(address addr) external {
        legacyOracle = addr;
    }

    ///
    /// ILido
    ///

    function handleOracleReport(
        ReportValues memory values
    ) external {
        _handleOracleReportLastCall
            .currentReportTimestamp = values.timestamp;
        _handleOracleReportLastCall
            .secondsElapsedSinceLastReport = values.timeElapsed;
        _handleOracleReportLastCall.numValidators = values.clValidators;
        _handleOracleReportLastCall.clBalance = values.clBalance;
        _handleOracleReportLastCall
            .withdrawalVaultBalance = values.withdrawalVaultBalance;
        _handleOracleReportLastCall
            .elRewardsVaultBalance = values.elRewardsVaultBalance;
        _handleOracleReportLastCall
            .sharesRequestedToBurn = values.sharesRequestedToBurn;
        _handleOracleReportLastCall
            .withdrawalFinalizationBatches = values.withdrawalFinalizationBatches;
        _handleOracleReportLastCall.simulatedShareRate = values.simulatedShareRate;
        ++_handleOracleReportLastCall.callCount;

        if (legacyOracle != address(0)) {
            IPostTokenRebaseReceiver(legacyOracle).handlePostTokenRebase(
                values.timestamp /* IGNORED reportTimestamp */,
                values.timeElapsed /* timeElapsed */,
                0 /* IGNORED preTotalShares */,
                0 /* preTotalEther */,
                1 /* postTotalShares */,
                1 /* postTotalEther */,
                1 /* IGNORED sharesMintedAsFees */
            );
        }
    }
}
