// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {IOracleReportSanityChecker} from "contracts/common/interfaces/IOracleReportSanityChecker.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {ReportValues} from "contracts/common/interfaces/ReportValues.sol";
import {IVaultHub} from "contracts/common/interfaces/IVaultHub.sol";

import {IPostTokenRebaseReceiver} from "./interfaces/IPostTokenRebaseReceiver.sol";

import {WithdrawalQueue} from "./WithdrawalQueue.sol";
import {StakingRouter} from "./StakingRouter.sol";


/// @title Lido Accounting contract
/// @author folkyatina
/// @notice contract is responsible for handling accounting oracle reports
/// calculating all the state changes that is required to apply the report
/// and distributing calculated values to relevant parts of the protocol
contract Accounting {
    struct Contracts {
        address accountingOracle;
        IOracleReportSanityChecker oracleReportSanityChecker;
        IBurner burner;
        WithdrawalQueue withdrawalQueue;
        IPostTokenRebaseReceiver postTokenRebaseReceiver;
        StakingRouter stakingRouter;
        IVaultHub vaultHub;
    }

    struct PreReportState {
        uint256 clValidators;
        uint256 clBalance;
        uint256 totalPooledEther;
        uint256 totalShares;
        uint256 depositedValidators;
        uint256 externalShares;
        uint256 externalEther;
        uint256 badDebtToInternalize;
    }

    /// @notice precalculated values that is used to change the state of the protocol during the report
    struct CalculatedValues {
        /// @notice amount of ether to collect from WithdrawalsVault to the buffer
        uint256 withdrawals;
        /// @notice amount of ether to collect from ELRewardsVault to the buffer
        uint256 elRewards;
        /// @notice amount of ether to transfer to WithdrawalQueue to finalize requests
        uint256 etherToFinalizeWQ;
        /// @notice number of stETH shares to transfer to Burner because of WQ finalization
        uint256 sharesToFinalizeWQ;
        /// @notice number of stETH shares transferred from WQ that will be burned this (to be removed)
        uint256 sharesToBurnForWithdrawals;
        /// @notice number of stETH shares that will be burned from Burner this report
        uint256 totalSharesToBurn;
        /// @notice number of stETH shares to mint as a protocol fee
        uint256 sharesToMintAsFees;
        /// @notice amount of NO fees to transfer to each module
        StakingRewardsDistribution rewardDistribution;
        /// @notice amount of CL ether that is not rewards earned during this report period
        /// the sum of CL balance on the previous report and the amount of fresh deposits since then
        uint256 principalClBalance;
        /// @notice total number of internal (not backed by vaults) stETH shares after the report is applied
        uint256 postInternalShares;
        /// @notice amount of ether under the protocol after the report is applied
        uint256 postInternalEther;
        /// @notice total number of stETH shares after the report is applied
        uint256 postTotalShares;
        /// @notice amount of ether under the protocol after the report is applied
        uint256 postTotalPooledEther;
    }

    struct StakingRewardsDistribution {
        address[] recipients;
        uint256[] moduleIds;
        uint96[] modulesFees;
        uint96 totalFee;
        uint256 precisionPoints;
    }

    error NotAuthorized(string operation, address addr);

    /// @notice deposit size in wei (for pre-maxEB accounting)
    uint256 private constant DEPOSIT_SIZE = 32 ether;

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;
    /// @notice Lido contract
    ILido public immutable LIDO;

    /// @param _lidoLocator Lido Locator contract
    /// @param _lido Lido contract
    constructor(
        ILidoLocator _lidoLocator,
        ILido _lido
    ) {
        LIDO_LOCATOR = _lidoLocator;
        LIDO = _lido;
    }

    /// @notice calculates all the state changes that is required to apply the report
    /// @param _report report values
    /// @param _withdrawalShareRate maximum share rate used for withdrawal finalization
    ///                             if _withdrawalShareRate == 0, no withdrawals are
    ///                             simulated
    function simulateOracleReport(
        ReportValues calldata _report,
        uint256 _withdrawalShareRate
    ) public view returns (CalculatedValues memory update) {
        Contracts memory contracts = _loadOracleReportContracts();
        PreReportState memory pre = _snapshotPreReportState(contracts);

        return _simulateOracleReport(contracts, pre, _report, _withdrawalShareRate);
    }

    /// @notice Updates accounting stats, collects EL rewards and distributes collected rewards
    ///        if beacon balance increased, performs withdrawal requests finalization
    /// @dev periodically called by the AccountingOracle contract
    function handleOracleReport(ReportValues calldata _report) external {
        Contracts memory contracts = _loadOracleReportContracts();
        if (msg.sender != contracts.accountingOracle) revert NotAuthorized("handleOracleReport", msg.sender);

        (
            PreReportState memory pre,
            CalculatedValues memory update,
            uint256 withdrawalsShareRate
        ) = _calculateOracleReportContext(contracts, _report);

        _applyOracleReportContext(contracts, _report, pre, update, withdrawalsShareRate);
    }

    /// @dev prepare all the required data to process the report
    function _calculateOracleReportContext(
        Contracts memory _contracts,
        ReportValues calldata _report
    ) internal view returns (PreReportState memory pre, CalculatedValues memory update, uint256 withdrawalsShareRate) {
        pre = _snapshotPreReportState(_contracts);

        CalculatedValues memory updateNoWithdrawals = _simulateOracleReport(_contracts, pre, _report, 0);

        withdrawalsShareRate = (updateNoWithdrawals.postTotalPooledEther * 1e27) / updateNoWithdrawals.postTotalShares;

        update = _simulateOracleReport(_contracts, pre, _report, withdrawalsShareRate);
    }

    /// @dev reads the current state of the protocol to the memory
    function _snapshotPreReportState(Contracts memory _contracts) internal view returns (PreReportState memory pre) {
        (pre.depositedValidators, pre.clValidators, pre.clBalance) = LIDO.getBeaconStat();
        pre.totalPooledEther = LIDO.getTotalPooledEther();
        pre.totalShares = LIDO.getTotalShares();
        pre.externalShares = LIDO.getExternalShares();
        pre.externalEther = LIDO.getExternalEther();
        pre.badDebtToInternalize = _contracts.vaultHub.badDebtToInternalizeAsOfLastRefSlot();
    }

    /// @dev calculates all the state changes that is required to apply the report
    /// @dev if _withdrawalsShareRate == 0, no withdrawals are simulated
    function _simulateOracleReport(
        Contracts memory _contracts,
        PreReportState memory _pre,
        ReportValues calldata _report,
        uint256 _withdrawalsShareRate
    ) internal view returns (CalculatedValues memory update) {
        update.rewardDistribution = _getStakingRewardsDistribution(_contracts.stakingRouter);

        if (_withdrawalsShareRate != 0) {
            // Get the ether to lock for withdrawal queue and shares to move to Burner to finalize requests
            (update.etherToFinalizeWQ, update.sharesToFinalizeWQ) = _calculateWithdrawals(
                _contracts,
                _report,
                _withdrawalsShareRate
            );
        }

        // Principal CL balance is the sum of the current CL balance and
        // validator deposits during this report
        // TODO: to support maxEB we need to get rid of validator counting
        update.principalClBalance = _pre.clBalance + (_report.clValidators - _pre.clValidators) * DEPOSIT_SIZE;

        // Limit the rebase to avoid oracle frontrunning
        // by leaving some ether to sit in EL rewards vault or withdrawals vault
        // and/or leaving some shares unburnt on Burner to be processed on future reports
        (
            update.withdrawals,
            update.elRewards,
            update.sharesToBurnForWithdrawals,
            update.totalSharesToBurn // shares to burn from Burner balance
        ) = _contracts.oracleReportSanityChecker.smoothenTokenRebase(
            _pre.totalPooledEther,
            _pre.totalShares,
            update.principalClBalance,
            _report.clBalance,
            _report.withdrawalVaultBalance,
            _report.elRewardsVaultBalance,
            _report.sharesRequestedToBurn,
            update.etherToFinalizeWQ,
            update.sharesToFinalizeWQ
        );

        uint256 postInternalSharesBeforeFees =
            _pre.totalShares - _pre.externalShares // internal shares before
            - update.totalSharesToBurn; // shares to be burned for withdrawals and cover

        update.postInternalEther =
            _pre.totalPooledEther - _pre.externalEther // internal ether before
            + _report.clBalance + update.withdrawals - update.principalClBalance // total cl rewards (or penalty)
            + update.elRewards // MEV and tips
            - update.etherToFinalizeWQ; // withdrawals

        // Pre-calculate total amount of protocol fees as the amount of shares that will be minted to pay it
        update.sharesToMintAsFees = _calculateLidoProtocolFeeShares(_report, update, postInternalSharesBeforeFees, update.postInternalEther);

        update.postInternalShares = postInternalSharesBeforeFees + update.sharesToMintAsFees + _pre.badDebtToInternalize;
        uint256 postExternalShares = _pre.externalShares - _pre.badDebtToInternalize; // can't underflow by design

        update.postTotalShares = update.postInternalShares + postExternalShares;
        update.postTotalPooledEther = update.postInternalEther + postExternalShares * update.postInternalEther / update.postInternalShares;
    }

    /// @dev return amount to lock on withdrawal queue and shares to burn depending on the finalization batch parameters
    function _calculateWithdrawals(
        Contracts memory _contracts,
        ReportValues calldata _report,
        uint256 _simulatedShareRate
    ) internal view returns (uint256 etherToLock, uint256 sharesToBurn) {
        if (_report.withdrawalFinalizationBatches.length != 0 && !_contracts.withdrawalQueue.isPaused()) {
            (etherToLock, sharesToBurn) = _contracts.withdrawalQueue.prefinalize(
                _report.withdrawalFinalizationBatches,
                _simulatedShareRate
            );
        }
    }

    /// @dev calculates shares that are minted as the protocol fees
    function _calculateLidoProtocolFeeShares(
        ReportValues calldata _report,
        CalculatedValues memory _update,
        uint256 _internalSharesBeforeFees,
        uint256 _internalEther
    ) internal pure returns (uint256 sharesToMintAsFees) {
        // we are calculating the share rate equal to the post-rebase share rate
        // but with fees taken as ether deduction instead of minting shares
        // to learn the amount of shares we need to mint to compensate for this fee

        uint256 unifiedClBalance = _report.clBalance + _update.withdrawals;
        // Don't mint/distribute any protocol fee on the non-profitable Lido oracle report
        // (when consensus layer balance delta is zero or negative).
        // See LIP-12 for details:
        // https://research.lido.fi/t/lip-12-on-chain-part-of-the-rewards-distribution-after-the-merge/1625
        if (unifiedClBalance > _update.principalClBalance) {
            uint256 totalRewards = unifiedClBalance - _update.principalClBalance + _update.elRewards;
            uint256 totalFee = _update.rewardDistribution.totalFee;
            uint256 precision = _update.rewardDistribution.precisionPoints;
            // amount of fees in ether
            uint256 feeEther = (totalRewards * totalFee) / precision;
            // but we won't pay fees in ether, so we need to calculate how many shares we need to mint as fees
            // using the share rate that takes fees into account
            // the share rate is the same as the post-rebase share rate
            // but with fees taken as ether deduction instead of minting shares
            // to learn the amount of shares we need to mint to compensate for this fee
            sharesToMintAsFees = (feeEther * _internalSharesBeforeFees) / (_internalEther - feeEther);
        }
    }

    /// @dev applies the precalculated changes to the protocol state
    function _applyOracleReportContext(
        Contracts memory _contracts,
        ReportValues calldata _report,
        PreReportState memory _pre,
        CalculatedValues memory _update,
        uint256 _withdrawalShareRate
    ) internal {
        _checkAccountingOracleReport(_contracts, _report, _pre, _update);

        uint256 lastWithdrawalRequestToFinalize;
        if (_update.sharesToFinalizeWQ > 0) {
            _contracts.burner.requestBurnShares(address(_contracts.withdrawalQueue), _update.sharesToFinalizeWQ);

            lastWithdrawalRequestToFinalize = _report.withdrawalFinalizationBatches[
                _report.withdrawalFinalizationBatches.length - 1
            ];
        }

        LIDO.processClStateUpdate(
            _report.timestamp,
            _pre.clValidators,
            _report.clValidators,
            _report.clBalance
        );

        if (_pre.badDebtToInternalize > 0) {
            _contracts.vaultHub.decreaseInternalizedBadDebt(_pre.badDebtToInternalize);
            LIDO.internalizeExternalBadDebt(_pre.badDebtToInternalize);
        }

        if (_update.totalSharesToBurn > 0) {
            _contracts.burner.commitSharesToBurn(_update.totalSharesToBurn);
        }

        // Distribute protocol fee (treasury & node operators)
        if (_update.sharesToMintAsFees > 0) {
            _distributeFee(_contracts.stakingRouter, _update.rewardDistribution, _update.sharesToMintAsFees);
        }

        LIDO.collectRewardsAndProcessWithdrawals(
            _report.timestamp,
            _report.clBalance,
            _update.principalClBalance,
            _update.withdrawals,
            _update.elRewards,
            lastWithdrawalRequestToFinalize,
            _withdrawalShareRate,
            _update.etherToFinalizeWQ
        );

        _notifyRebaseObserver(_contracts.postTokenRebaseReceiver, _report, _pre, _update);

        LIDO.emitTokenRebase(
            _report.timestamp,
            _report.timeElapsed,
            _pre.totalShares,
            _pre.totalPooledEther,
            _update.postTotalShares,
            _update.postTotalPooledEther,
            _update.postInternalShares,
            _update.postInternalEther,
            _update.sharesToMintAsFees
        );
    }

    /// @dev checks the provided oracle data internally and against the sanity checker contract
    /// reverts if a check fails
    function _checkAccountingOracleReport(
        Contracts memory _contracts,
        ReportValues calldata _report,
        PreReportState memory _pre,
        CalculatedValues memory _update
    ) internal {
        if (_report.timestamp >= block.timestamp) revert IncorrectReportTimestamp(_report.timestamp, block.timestamp);
        if (_report.clValidators < _pre.clValidators || _report.clValidators > _pre.depositedValidators) {
            revert IncorrectReportValidators(_report.clValidators, _pre.clValidators, _pre.depositedValidators);
        }

        _contracts.oracleReportSanityChecker.checkAccountingOracleReport(
            _report.timeElapsed,
            _update.principalClBalance,
            _report.clBalance,
            _report.withdrawalVaultBalance,
            _report.elRewardsVaultBalance,
            _report.sharesRequestedToBurn,
            _pre.clValidators,
            _report.clValidators
        );

        if (_report.withdrawalFinalizationBatches.length > 0) {
            _contracts.oracleReportSanityChecker.checkWithdrawalQueueOracleReport(
                _report.withdrawalFinalizationBatches[_report.withdrawalFinalizationBatches.length - 1],
                _report.timestamp
            );
        }
    }

    /// @dev Notify observer about the completed token rebase.
    function _notifyRebaseObserver(
        IPostTokenRebaseReceiver _postTokenRebaseReceiver,
        ReportValues calldata _report,
        PreReportState memory _pre,
        CalculatedValues memory _update
    ) internal {
        if (address(_postTokenRebaseReceiver) != address(0)) {
            _postTokenRebaseReceiver.handlePostTokenRebase(
                _report.timestamp,
                _report.timeElapsed,
                _pre.totalShares,
                _pre.totalPooledEther,
                _update.postTotalShares,
                _update.postTotalPooledEther,
                _update.sharesToMintAsFees
            );
        }
    }

    /// @dev mints protocol fees to the treasury and node operators
    function _distributeFee(
        StakingRouter _stakingRouter,
        StakingRewardsDistribution memory _rewardsDistribution,
        uint256 _sharesToMintAsFees
    ) internal {
        (uint256[] memory moduleFees, uint256 totalModuleFees) = _mintModuleFees(
            _rewardsDistribution.recipients,
            _rewardsDistribution.modulesFees,
            _rewardsDistribution.totalFee,
            _sharesToMintAsFees
        );

        _mintTreasuryFees(_sharesToMintAsFees - totalModuleFees);

        _stakingRouter.reportRewardsMinted(_rewardsDistribution.moduleIds, moduleFees);
    }

    /// @dev mint rewards to the StakingModule recipients
    function _mintModuleFees(
        address[] memory _recipients,
        uint96[] memory _modulesFees,
        uint256 _totalFee,
        uint256 _totalFees
    ) internal returns (uint256[] memory moduleFees, uint256 totalModuleFees) {
        moduleFees = new uint256[](_recipients.length);

        for (uint256 i; i < _recipients.length; ++i) {
            if (_modulesFees[i] > 0) {
                uint256 iModuleFees = (_totalFees * _modulesFees[i]) / _totalFee;
                moduleFees[i] = iModuleFees;
                LIDO.mintShares(_recipients[i], iModuleFees);
                totalModuleFees = totalModuleFees + iModuleFees;
            }
        }
    }

    /// @dev mints treasury fees
    function _mintTreasuryFees(uint256 _amount) internal {
        address treasury = LIDO_LOCATOR.treasury();

        LIDO.mintShares(treasury, _amount);
    }

    /// @dev loads the required contracts from the LidoLocator to the struct in the memory
    function _loadOracleReportContracts() internal view returns (Contracts memory) {
        (
            address accountingOracle,
            address oracleReportSanityChecker,
            address burner,
            address withdrawalQueue,
            address postTokenRebaseReceiver,
            address stakingRouter,
            address vaultHub
        ) = LIDO_LOCATOR.oracleReportComponents();

        return
            Contracts(
                accountingOracle,
                IOracleReportSanityChecker(oracleReportSanityChecker),
                IBurner(burner),
                WithdrawalQueue(withdrawalQueue),
                IPostTokenRebaseReceiver(postTokenRebaseReceiver),
                StakingRouter(payable(stakingRouter)),
                IVaultHub(payable(vaultHub))
            );
    }

    /// @dev loads the staking rewards distribution to the struct in the memory
    function _getStakingRewardsDistribution(
        StakingRouter _stakingRouter
    ) internal view returns (StakingRewardsDistribution memory ret) {
        (ret.recipients, ret.moduleIds, ret.modulesFees, ret.totalFee, ret.precisionPoints) = _stakingRouter
            .getStakingRewardsDistribution();

        if (ret.recipients.length != ret.modulesFees.length)
            revert UnequalArrayLengths(ret.recipients.length, ret.modulesFees.length);
        if (ret.moduleIds.length != ret.modulesFees.length)
            revert UnequalArrayLengths(ret.moduleIds.length, ret.modulesFees.length);
    }

    error UnequalArrayLengths(uint256 firstArrayLength, uint256 secondArrayLength);
    error IncorrectReportTimestamp(uint256 reportTimestamp, uint256 upperBoundTimestamp);
    error IncorrectReportValidators(uint256 reportValidators, uint256 minValidators, uint256 maxValidators);
}
