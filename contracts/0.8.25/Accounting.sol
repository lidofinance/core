// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./vaults/VaultHub.sol";

import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {IBurner} from "../common/interfaces/IBurner.sol";
import {IPostTokenRebaseReceiver} from "./interfaces/IPostTokenRebaseReceiver.sol";
import {IStakingRouter} from "./interfaces/IStakingRouter.sol";
import {IOracleReportSanityChecker} from "./interfaces/IOracleReportSanityChecker.sol";
import {IWithdrawalQueue} from "./interfaces/IWithdrawalQueue.sol";
import {ILido} from "./interfaces/ILido.sol";
import {ReportValues} from "contracts/common/interfaces/ReportValues.sol";

/// @title Lido Accounting contract
/// @author folkyatina
/// @notice contract is responsible for handling oracle reports
/// calculating all the state changes that is required to apply the report
/// and distributing calculated values to relevant parts of the protocol
contract Accounting is VaultHub {
    struct Contracts {
        address accountingOracleAddress;
        IOracleReportSanityChecker oracleReportSanityChecker;
        IBurner burner;
        IWithdrawalQueue withdrawalQueue;
        IPostTokenRebaseReceiver postTokenRebaseReceiver;
        IStakingRouter stakingRouter;
    }

    struct PreReportState {
        uint256 clValidators;
        uint256 clBalance;
        uint256 totalPooledEther;
        uint256 totalShares;
        uint256 depositedValidators;
        uint256 externalEther;
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
        /// @notice number of stETH shares to mint as a fee to Lido treasury
        uint256 sharesToMintAsFees;
        /// @notice amount of NO fees to transfer to each module
        StakingRewardsDistribution rewardDistribution;
        /// @notice amount of CL ether that is not rewards earned during this report period
        uint256 principalClBalance;
        /// @notice total number of stETH shares after the report is applied
        uint256 postTotalShares;
        /// @notice amount of ether under the protocol after the report is applied
        uint256 postTotalPooledEther;
        /// @notice rebased amount of external ether
        uint256 externalEther;
        /// @notice amount of ether to be locked in the vaults
        uint256[] vaultsLockedEther;
        /// @notice amount of shares to be minted as vault fees to the treasury
        uint256[] vaultsTreasuryFeeShares;
    }

    struct StakingRewardsDistribution {
        address[] recipients;
        uint256[] moduleIds;
        uint96[] modulesFees;
        uint96 totalFee;
        uint256 precisionPoints;
    }

    /// @notice deposit size in wei (for pre-maxEB accounting)
    uint256 private constant DEPOSIT_SIZE = 32 ether;

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;
    /// @notice Lido contract
    ILido public immutable LIDO;

    constructor(
        ILidoLocator _lidoLocator,
        ILido _lido,
        address _treasury
    ) VaultHub(_lido, _treasury) {
        LIDO_LOCATOR = _lidoLocator;
        LIDO = _lido;
    }

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __VaultHub_init(_admin);
    }

    /// @notice calculates all the state changes that is required to apply the report
    /// @param _report report values
    /// @param _withdrawalShareRate maximum share rate used for withdrawal resolution
    ///                             if _withdrawalShareRate == 0, no withdrawals are
    ///                             simulated
    function simulateOracleReport(
        ReportValues memory _report,
        uint256 _withdrawalShareRate
    ) public view returns (CalculatedValues memory update) {
        Contracts memory contracts = _loadOracleReportContracts();
        PreReportState memory pre = _snapshotPreReportState();

        return _simulateOracleReport(contracts, pre, _report, _withdrawalShareRate);
    }

    /// @notice Updates accounting stats, collects EL rewards and distributes collected rewards
    ///        if beacon balance increased, performs withdrawal requests finalization
    /// @dev periodically called by the AccountingOracle contract
    function handleOracleReport(ReportValues memory _report) external {
        Contracts memory contracts = _loadOracleReportContracts();
        if (msg.sender != contracts.accountingOracleAddress) revert NotAuthorized("handleOracleReport", msg.sender);

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
        ReportValues memory _report
    ) internal view returns (PreReportState memory pre, CalculatedValues memory update, uint256 withdrawalsShareRate) {
        pre = _snapshotPreReportState();

        CalculatedValues memory updateNoWithdrawals = _simulateOracleReport(_contracts, pre, _report, 0);

        withdrawalsShareRate = (updateNoWithdrawals.postTotalPooledEther * 1e27) / updateNoWithdrawals.postTotalShares;

        update = _simulateOracleReport(_contracts, pre, _report, withdrawalsShareRate);
    }

    /// @dev reads the current state of the protocol to the memory
    function _snapshotPreReportState() internal view returns (PreReportState memory pre) {
        (pre.depositedValidators, pre.clValidators, pre.clBalance) = LIDO.getBeaconStat();
        pre.totalPooledEther = LIDO.getTotalPooledEther();
        pre.totalShares = LIDO.getTotalShares();
        pre.externalEther = LIDO.getExternalEther();
    }

    /// @dev calculates all the state changes that is required to apply the report
    /// @dev if _withdrawalsShareRate == 0, no withdrawals are simulated
    function _simulateOracleReport(
        Contracts memory _contracts,
        PreReportState memory _pre,
        ReportValues memory _report,
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
        // by leaving some ether to sit in elrevards vault or withdrawals vault
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

        // Pre-calculate total amount of protocol fees for this rebase
        // amount of shares that will be minted to pay it
        // and the new value of externalEther after the rebase
        (update.sharesToMintAsFees, update.externalEther) = _calculateFeesAndExternalBalance(_report, _pre, update);

        // Calculate the new total shares and total pooled ether after the rebase
        update.postTotalShares =
            _pre.totalShares + // totalShares already includes externalShares
            update.sharesToMintAsFees - // new shares minted to pay fees
            update.totalSharesToBurn; // shares burned for withdrawals and cover

        update.postTotalPooledEther =
            _pre.totalPooledEther + // was before the report
            _report.clBalance +
            update.withdrawals -
            update.principalClBalance + // total cl rewards (or penalty)
            update.elRewards + // elrewards
            update.externalEther -
            _pre.externalEther - // vaults rewards
            update.etherToFinalizeWQ; // withdrawals

        // Calculate the amount of ether locked in the vaults to back external balance of stETH
        // and the amount of shares to mint as fees to the treasury for each vaults
        (update.vaultsLockedEther, update.vaultsTreasuryFeeShares) = _calculateVaultsRebase(
            update.postTotalShares,
            update.postTotalPooledEther,
            _pre.totalShares,
            _pre.totalPooledEther,
            update.sharesToMintAsFees
        );
    }

    /// @dev return amount to lock on withdrawal queue and shares to burn depending on the finalization batch parameters
    function _calculateWithdrawals(
        Contracts memory _contracts,
        ReportValues memory _report,
        uint256 _simulatedShareRate
    ) internal view returns (uint256 etherToLock, uint256 sharesToBurn) {
        if (_report.withdrawalFinalizationBatches.length != 0 && !_contracts.withdrawalQueue.isPaused()) {
            (etherToLock, sharesToBurn) = _contracts.withdrawalQueue.prefinalize(
                _report.withdrawalFinalizationBatches,
                _simulatedShareRate
            );
        }
    }

    /// @dev calculates shares that are minted to treasury as the protocol fees
    ///      and rebased value of the external balance
    function _calculateFeesAndExternalBalance(
        ReportValues memory _report,
        PreReportState memory _pre,
        CalculatedValues memory _calculated
    ) internal view returns (uint256 sharesToMintAsFees, uint256 externalEther) {
        // we are calculating the share rate equal to the post-rebase share rate
        // but with fees taken as eth deduction
        // and without externalBalance taken into account
        uint256 externalShares = LIDO.getSharesByPooledEth(_pre.externalEther);
        uint256 shares = _pre.totalShares - _calculated.totalSharesToBurn - externalShares;
        uint256 eth = _pre.totalPooledEther - _calculated.etherToFinalizeWQ - _pre.externalEther;

        uint256 unifiedClBalance = _report.clBalance + _calculated.withdrawals;

        // Don't mint/distribute any protocol fee on the non-profitable Lido oracle report
        // (when consensus layer balance delta is zero or negative).
        // See LIP-12 for details:
        // https://research.lido.fi/t/lip-12-on-chain-part-of-the-rewards-distribution-after-the-merge/1625
        if (unifiedClBalance > _calculated.principalClBalance) {
            uint256 totalRewards = unifiedClBalance - _calculated.principalClBalance + _calculated.elRewards;
            uint256 totalFee = _calculated.rewardDistribution.totalFee;
            uint256 precision = _calculated.rewardDistribution.precisionPoints;
            uint256 feeEther = (totalRewards * totalFee) / precision;
            eth += totalRewards - feeEther;

            // but we won't pay fees in ether, so we need to calculate how many shares we need to mint as fees
            sharesToMintAsFees = (feeEther * shares) / eth;
        } else {
            uint256 clPenalty = _calculated.principalClBalance - unifiedClBalance;
            eth = eth - clPenalty + _calculated.elRewards;
        }

        // externalBalance is rebasing at the same rate as the primary balance does
        externalEther = (externalShares * eth) / shares;
    }

    /// @dev applies the precalculated changes to the protocol state
    function _applyOracleReportContext(
        Contracts memory _contracts,
        ReportValues memory _report,
        PreReportState memory _pre,
        CalculatedValues memory _update,
        uint256 _simulatedShareRate
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
            _report.clBalance,
            _update.externalEther
        );

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
            _simulatedShareRate,
            _update.etherToFinalizeWQ
        );

        _updateVaults(
            _report.vaultValues,
            _report.netCashFlows,
            _update.vaultsLockedEther,
            _update.vaultsTreasuryFeeShares
        );

        _notifyObserver(_contracts.postTokenRebaseReceiver, _report, _pre, _update);

        LIDO.emitTokenRebase(
            _report.timestamp,
            _report.timeElapsed,
            _pre.totalShares,
            _pre.totalPooledEther,
            _update.postTotalShares,
            _update.postTotalPooledEther,
            _update.sharesToMintAsFees
        );
    }

    /// @dev checks the provided oracle data internally and against the sanity checker contract
    /// reverts if a check fails
    function _checkAccountingOracleReport(
        Contracts memory _contracts,
        ReportValues memory _report,
        PreReportState memory _pre,
        CalculatedValues memory _update
    ) internal view {
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
    function _notifyObserver(
        IPostTokenRebaseReceiver _postTokenRebaseReceiver,
        ReportValues memory _report,
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
        IStakingRouter _stakingRouter,
        StakingRewardsDistribution memory _rewardsDistribution,
        uint256 _sharesToMintAsFees
    ) internal {
        (uint256[] memory moduleRewards, uint256 totalModuleRewards) = _mintModuleRewards(
            _rewardsDistribution.recipients,
            _rewardsDistribution.modulesFees,
            _rewardsDistribution.totalFee,
            _sharesToMintAsFees
        );

        _mintTreasuryRewards(_sharesToMintAsFees - totalModuleRewards);

        _stakingRouter.reportRewardsMinted(_rewardsDistribution.moduleIds, moduleRewards);
    }

    /// @dev mint rewards to the StakingModule recipients
    function _mintModuleRewards(
        address[] memory _recipients,
        uint96[] memory _modulesFees,
        uint256 _totalFee,
        uint256 _totalRewards
    ) internal returns (uint256[] memory moduleRewards, uint256 totalModuleRewards) {
        moduleRewards = new uint256[](_recipients.length);

        for (uint256 i; i < _recipients.length; ++i) {
            if (_modulesFees[i] > 0) {
                uint256 iModuleRewards = (_totalRewards * _modulesFees[i]) / _totalFee;
                moduleRewards[i] = iModuleRewards;
                LIDO.mintShares(_recipients[i], iModuleRewards);
                totalModuleRewards = totalModuleRewards + iModuleRewards;
            }
        }
    }

    /// @dev mints treasury rewards
    function _mintTreasuryRewards(uint256 _amount) internal {
        address treasury = LIDO_LOCATOR.treasury();

        LIDO.mintShares(treasury, _amount);
    }

    /// @dev loads the required contracts from the LidoLocator to the struct in the memory
    function _loadOracleReportContracts() internal view returns (Contracts memory) {
        (
            address accountingOracleAddress,
            address oracleReportSanityChecker,
            address burner,
            address withdrawalQueue,
            address postTokenRebaseReceiver,
            address stakingRouter
        ) = LIDO_LOCATOR.oracleReportComponents();

        return
            Contracts(
                accountingOracleAddress,
                IOracleReportSanityChecker(oracleReportSanityChecker),
                IBurner(burner),
                IWithdrawalQueue(withdrawalQueue),
                IPostTokenRebaseReceiver(postTokenRebaseReceiver),
                IStakingRouter(stakingRouter)
            );
    }

    /// @dev loads the staking rewards distribution to the struct in the memory
    function _getStakingRewardsDistribution(
        IStakingRouter _stakingRouter
    ) internal view returns (StakingRewardsDistribution memory ret) {
        (ret.recipients, ret.moduleIds, ret.modulesFees, ret.totalFee, ret.precisionPoints) = _stakingRouter
            .getStakingRewardsDistribution();

        if (ret.recipients.length != ret.modulesFees.length)
            revert InequalArrayLengths(ret.recipients.length, ret.modulesFees.length);
        if (ret.moduleIds.length != ret.modulesFees.length)
            revert InequalArrayLengths(ret.moduleIds.length, ret.modulesFees.length);
    }

    error InequalArrayLengths(uint256 firstArrayLength, uint256 secondArrayLength);
    error IncorrectReportTimestamp(uint256 reportTimestamp, uint256 upperBoundTimestamp);
    error IncorrectReportValidators(uint256 reportValidators, uint256 minValidators, uint256 maxValidators);
}
