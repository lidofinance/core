// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {ILido} from "contracts/0.8.9/oracle/AccountingOracle.sol";

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

contract Lido__MockForAccountingOracle is ILido {
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

    function getLastCall_handleOracleReport() external view returns (HandleOracleReportLastCall memory) {
        return _handleOracleReportLastCall;
    }

    function setLegacyOracle(address addr) external {
        legacyOracle = addr;
    }

    ///
    /// ILido
    ///

    function handleOracleReport(
        uint256 currentReportTimestamp,
        uint256 secondsElapsedSinceLastReport,
        uint256 numValidators,
        uint256 clBalance,
        uint256 withdrawalVaultBalance,
        uint256 elRewardsVaultBalance,
        uint256 sharesRequestedToBurn,
        uint256[] calldata withdrawalFinalizationBatches,
        uint256 simulatedShareRate
    ) external {
        _handleOracleReportLastCall.currentReportTimestamp = currentReportTimestamp;
        _handleOracleReportLastCall.secondsElapsedSinceLastReport = secondsElapsedSinceLastReport;
        _handleOracleReportLastCall.numValidators = numValidators;
        _handleOracleReportLastCall.clBalance = clBalance;
        _handleOracleReportLastCall.withdrawalVaultBalance = withdrawalVaultBalance;
        _handleOracleReportLastCall.elRewardsVaultBalance = elRewardsVaultBalance;
        _handleOracleReportLastCall.sharesRequestedToBurn = sharesRequestedToBurn;
        _handleOracleReportLastCall.withdrawalFinalizationBatches = withdrawalFinalizationBatches;
        _handleOracleReportLastCall.simulatedShareRate = simulatedShareRate;
        ++_handleOracleReportLastCall.callCount;

        if (legacyOracle != address(0)) {
            IPostTokenRebaseReceiver(legacyOracle).handlePostTokenRebase(
                currentReportTimestamp /* IGNORED reportTimestamp */,
                secondsElapsedSinceLastReport /* timeElapsed */,
                0 /* IGNORED preTotalShares */,
                0 /* preTotalEther */,
                1 /* postTotalShares */,
                1 /* postTotalEther */,
                1 /* IGNORED sharesMintedAsFees */
            );
        }
    }
}
