// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {IBurner} from "../common/interfaces/IBurner.sol";
import {VaultHub} from "./vaults/VaultHub.sol";
import {OracleReportSanityChecker} from "./sanity_checks/OracleReportSanityChecker.sol";

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

interface IStakingRouter {
    function getStakingRewardsDistribution()
        external
        view
        returns (
            address[] memory recipients,
            uint256[] memory stakingModuleIds,
            uint96[] memory stakingModuleFees,
            uint96 totalFee,
            uint256 precisionPoints
        );

    function reportRewardsMinted(
        uint256[] memory _stakingModuleIds,
        uint256[] memory _totalShares
    ) external;
}

interface IWithdrawalQueue {
    function prefinalize(uint256[] memory _batches, uint256 _maxShareRate)
        external
        view
        returns (uint256 ethToLock, uint256 sharesToBurn);

    function isPaused() external view returns (bool);
}

interface ILido {
    function getTotalPooledEther() external view returns (uint256);
    function getExternalEther() external view returns (uint256);
    function getTotalShares() external view returns (uint256);
    function getSharesByPooledEth(uint256) external view returns (uint256);
    function getBeaconStat() external view returns (
        uint256 depositedValidators,
        uint256 beaconValidators,
        uint256 beaconBalance
    );
    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _preClValidators,
        uint256 _reportClValidators,
        uint256 _reportClBalance,
        uint256 _postExternalBalance
    ) external;
    function collectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _adjustedPreCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _simulatedShareRate,
        uint256 _etherToLockOnWithdrawalQueue
    ) external;
    function emitTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external;
    function mintShares(address _recipient, uint256 _sharesAmount) external;
    function burnShares(address _account, uint256 _sharesAmount) external;
}

struct ReportValues {
    /// @notice timestamp of the block the report is based on. All provided report values is actual on this timestamp
    uint256 timestamp;
    /// @notice seconds elapsed since the previous report
    uint256 timeElapsed;
    /// @notice total number of Lido validators on Consensus Layers (exited included)
    uint256 clValidators;
    /// @notice sum of all Lido validators' balances on Consensus Layer
    uint256 clBalance;
    /// @notice withdrawal vault balance
    uint256 withdrawalVaultBalance;
    /// @notice elRewards vault balance
    uint256 elRewardsVaultBalance;
    /// @notice stETH shares requested to burn through Burner
    uint256 sharesRequestedToBurn;
    /// @notice the ascendingly-sorted array of withdrawal request IDs obtained by calling
    /// WithdrawalQueue.calculateFinalizationBatches. Can be empty array if no withdrawal to finalize
    uint256[] withdrawalFinalizationBatches;
    /// @notice array of combined values for each Lido vault
    ///         (sum of all the balances of Lido validators of the vault
    ///          plus the balance of the vault itself)
    uint256[] vaultValues;
    /// @notice netCashFlow of each Lido vault
    ///         (difference between deposits to and withdrawals from the vault)
    int256[] netCashFlows;
}

/// @title Lido Accounting contract
/// @author folkyatina
/// @notice contract is responsible for handling oracle reports
/// calculating all the state changes that is required to apply the report
/// and distributing calculated values to relevant parts of the protocol
contract Accounting is VaultHub {
    /// @notice deposit size in wei (for pre-maxEB accounting)
    uint256 private constant DEPOSIT_SIZE = 32 ether;

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;
    /// @notice Lido contract
    ILido public immutable LIDO;

    constructor(address _admin, ILidoLocator _lidoLocator, ILido _lido, address _treasury)
        VaultHub(_admin, address(_lido), _treasury){
        LIDO_LOCATOR = _lidoLocator;
        LIDO = _lido;
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

    function calculateOracleReportContext(
        ReportValues memory _report
    ) public view returns (
        PreReportState memory pre,
        CalculatedValues memory update,
        uint256 simulatedShareRate
    ) {
        Contracts memory contracts = _loadOracleReportContracts();

        return _calculateOracleReportContext(contracts, _report);
    }

    /**
     * @notice Updates accounting stats, collects EL rewards and distributes collected rewards
     *         if beacon balance increased, performs withdrawal requests finalization
     * @dev periodically called by the AccountingOracle contract
     */
    function handleOracleReport(
        ReportValues memory _report
    ) external {
        Contracts memory contracts = _loadOracleReportContracts();
        if (msg.sender != contracts.accountingOracleAddress) revert NotAuthorized("handleOracleReport", msg.sender);

        (PreReportState memory pre, CalculatedValues memory update, uint256 simulatedShareRate)
            = _calculateOracleReportContext(contracts, _report);

        _applyOracleReportContext(contracts, _report, pre, update, simulatedShareRate);
    }

    function _calculateOracleReportContext(
        Contracts memory _contracts,
        ReportValues memory _report
    ) internal view returns (
        PreReportState memory pre,
        CalculatedValues memory update,
        uint256 simulatedShareRate
    ) {
        pre = _snapshotPreReportState();

        CalculatedValues memory updateNoWithdrawals = _simulateOracleReport(_contracts, pre, _report, 0);

        simulatedShareRate = updateNoWithdrawals.postTotalPooledEther * 1e27 / updateNoWithdrawals.postTotalShares;

        update = _simulateOracleReport(_contracts, pre, _report, simulatedShareRate);
    }

    function _snapshotPreReportState() internal view returns (PreReportState memory pre) {
        pre = PreReportState(0, 0, 0, 0, 0, 0);
        (pre.depositedValidators, pre.clValidators, pre.clBalance) = LIDO.getBeaconStat();
        pre.totalPooledEther = LIDO.getTotalPooledEther();
        pre.totalShares = LIDO.getTotalShares();
        pre.externalEther = LIDO.getExternalEther();
    }

    function _simulateOracleReport(
        Contracts memory _contracts,
        PreReportState memory _pre,
        ReportValues memory _report,
        uint256 _simulatedShareRate
    ) internal view returns (CalculatedValues memory update){
        update.rewardDistribution = _getStakingRewardsDistribution(_contracts.stakingRouter);

        if (_simulatedShareRate != 0) {
            // Get the ether to lock for withdrawal queue and shares to move to Burner to finalize requests
            (
                update.etherToFinalizeWQ,
                update.sharesToFinalizeWQ
            ) = _calculateWithdrawals(_contracts, _report, _simulatedShareRate);
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
        (
            update.sharesToMintAsFees,
            update.externalEther
        ) = _calculateFeesAndExternalBalance(_report, _pre, update);

        // Calculate the new total shares and total pooled ether after the rebase
        update.postTotalShares = _pre.totalShares // totalShares already includes externalShares
            + update.sharesToMintAsFees // new shares minted to pay fees
            - update.totalSharesToBurn; // shares burned for withdrawals and cover

        update.postTotalPooledEther = _pre.totalPooledEther // was before the report
            + _report.clBalance + update.withdrawals - update.principalClBalance // total cl rewards (or penalty)
            + update.elRewards // elrewards
            + update.externalEther - _pre.externalEther // vaults rewards
            - update.etherToFinalizeWQ; // withdrawals

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
            uint256 feeEther = totalRewards * totalFee / precision;
            eth += totalRewards - feeEther;

            // but we won't pay fees in ether, so we need to calculate how many shares we need to mint as fees
            sharesToMintAsFees = feeEther * shares / eth;
        } else {
            uint256 clPenalty = _calculated.principalClBalance - unifiedClBalance;
            eth = eth - clPenalty + _calculated.elRewards;
        }

        // externalBalance is rebasing at the same rate as the primary balance does
        externalEther = externalShares * eth / shares;
    }

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
            _contracts.burner.requestBurnShares(
                address(_contracts.withdrawalQueue), _update.sharesToFinalizeWQ
            );

            lastWithdrawalRequestToFinalize =
                _report.withdrawalFinalizationBatches[_report.withdrawalFinalizationBatches.length - 1];
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
            _distributeFee(
                _contracts.stakingRouter,
                _update.rewardDistribution,
                _update.sharesToMintAsFees
            );
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

        _completeTokenRebase(_contracts.postTokenRebaseReceiver, _report, _pre, _update);

        LIDO.emitTokenRebase(
            _report.timestamp,
            _report.timeElapsed,
            _pre.totalShares,
            _pre.totalPooledEther,
            _update.postTotalShares,
            _update.postTotalPooledEther,
            _update.sharesToMintAsFees
        );

        // TODO: assert realPostTPE and realPostTS against calculated
    }

    /**
     * @dev Pass the provided oracle data to the sanity checker contract
     * Works with structures to overcome `stack too deep`
     */
    function _checkAccountingOracleReport(
        Contracts memory _contracts,
        ReportValues memory _report,
        PreReportState memory _pre,
        CalculatedValues memory _update
    ) internal view {
        if (_report.timestamp >= block.timestamp) revert IncorrectReportTimestamp(_report.timestamp, block.timestamp);
        if (_report.clValidators < _pre.clValidators || _report.clValidators >  _pre.depositedValidators) {
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

    /**
     * @dev Notify observers about the completed token rebase.
     * Emit events and call external receivers.
     */
    function _completeTokenRebase(
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

    function _distributeFee(
        IStakingRouter _stakingRouter,
        StakingRewardsDistribution memory _rewardsDistribution,
        uint256 _sharesToMintAsFees
    ) internal {
        (uint256[] memory moduleRewards, uint256 totalModuleRewards) =
            _transferModuleRewards(
                _rewardsDistribution.recipients,
                _rewardsDistribution.modulesFees,
                _rewardsDistribution.totalFee,
                _sharesToMintAsFees
            );

        _transferTreasuryRewards(_sharesToMintAsFees - totalModuleRewards);

        _stakingRouter.reportRewardsMinted(
            _rewardsDistribution.moduleIds,
            moduleRewards
        );
    }

    function _transferModuleRewards(
        address[] memory recipients,
        uint96[] memory modulesFees,
        uint256 totalFee,
        uint256 totalRewards
    ) internal returns (uint256[] memory moduleRewards, uint256 totalModuleRewards) {
        moduleRewards = new uint256[](recipients.length);

        for (uint256 i; i < recipients.length; ++i) {
            if (modulesFees[i] > 0) {
                uint256 iModuleRewards = totalRewards * modulesFees[i] / totalFee;
                moduleRewards[i] = iModuleRewards;
                LIDO.mintShares(recipients[i], iModuleRewards);
                totalModuleRewards = totalModuleRewards + iModuleRewards;
            }
        }
    }

    function _transferTreasuryRewards(uint256 treasuryReward) internal {
        address treasury = LIDO_LOCATOR.treasury();

        LIDO.mintShares(treasury, treasuryReward);
    }

    struct Contracts {
        address accountingOracleAddress;
        OracleReportSanityChecker oracleReportSanityChecker;
        IBurner burner;
        IWithdrawalQueue withdrawalQueue;
        IPostTokenRebaseReceiver postTokenRebaseReceiver;
        IStakingRouter stakingRouter;
    }

    function _loadOracleReportContracts() internal view returns (Contracts memory) {

        (
            address accountingOracleAddress,
            address oracleReportSanityChecker,
            address burner,
            address withdrawalQueue,
            address postTokenRebaseReceiver,
            address stakingRouter
        ) = LIDO_LOCATOR.oracleReportComponents();

        return Contracts(
            accountingOracleAddress,
            OracleReportSanityChecker(oracleReportSanityChecker),
            IBurner(burner),
            IWithdrawalQueue(withdrawalQueue),
            IPostTokenRebaseReceiver(postTokenRebaseReceiver),
            IStakingRouter(stakingRouter)
        );
    }

    struct StakingRewardsDistribution {
        address[] recipients;
        uint256[] moduleIds;
        uint96[] modulesFees;
        uint96 totalFee;
        uint256 precisionPoints;
    }

    function _getStakingRewardsDistribution(IStakingRouter _stakingRouter)
        internal view returns (StakingRewardsDistribution memory ret) {
        (
            ret.recipients,
            ret.moduleIds,
            ret.modulesFees,
            ret.totalFee,
            ret.precisionPoints
        ) = _stakingRouter.getStakingRewardsDistribution();

        require(ret.recipients.length == ret.modulesFees.length, "WRONG_RECIPIENTS_INPUT");
        require(ret.moduleIds.length == ret.modulesFees.length, "WRONG_MODULE_IDS_INPUT");
    }

    error IncorrectReportTimestamp(uint256 reportTimestamp, uint256 upperBoundTimestamp);
    error IncorrectReportValidators(uint256 reportValidators, uint256 minValidators, uint256 maxValidators);
}
