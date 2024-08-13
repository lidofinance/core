// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {IBurner} from "../common/interfaces/IBurner.sol";
import {VaultHub} from "./vaults/VaultHub.sol";

interface IOracleReportSanityChecker {
    function checkAccountingOracleReport(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _preCLValidators,
        uint256 _postCLValidators,
        uint256 _depositedValidators
    ) external view;

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
        uint256 simulatedSharesToBurn,
        uint256 sharesToBurn
    );

    function checkWithdrawalQueueOracleReport(
        uint256 _lastFinalizableRequestId,
        uint256 _reportTimestamp
    ) external view;

    function checkSimulatedShareRate(
        uint256 _postTotalPooledEther,
        uint256 _postTotalShares,
        uint256 _etherLockedOnWithdrawalQueue,
        uint256 _sharesBurntDueToWithdrawals,
        uint256 _simulatedShareRate
    ) external view;
}

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
    /// @notice share rate that was simulated by oracle when the report data created (1e27 precision)
    uint256 simulatedShareRate;
    /// @notice array of aggregated balances of validators for each Lido vault
    uint256[] clBalances;
    /// @notice balances of Lido vaults
    uint256[] elBalances;
    /// @notice value of netCashFlow of each Lido vault
    uint256[] netCashFlows;
}

/// This contract is responsible for handling oracle reports
contract Accounting is VaultHub {
    uint256 private constant DEPOSIT_SIZE = 32 ether;

    ILidoLocator public immutable LIDO_LOCATOR;
    ILido public immutable LIDO;

    constructor(ILidoLocator _lidoLocator, ILido _lido) VaultHub(address(_lido)){
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
        uint256 sharesToBurnDueToWQThisReport;
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

        uint256[] lockedEther;
    }

    struct ReportContext {
        ReportValues report;
        PreReportState pre;
        CalculatedValues update;
    }

    function calculateOracleReportContext(
        ReportValues memory _report
    ) internal view returns (ReportContext memory) {
        Contracts memory contracts = _loadOracleReportContracts();
        return _calculateOracleReportContext(contracts, _report);
    }


    /**
     * @notice Updates accounting stats, collects EL rewards and distributes collected rewards
     *         if beacon balance increased, performs withdrawal requests finalization
     * @dev periodically called by the AccountingOracle contract
     *
     * @return postRebaseAmounts
     *  [0]: `postTotalPooledEther` amount of ether in the protocol after report
     *  [1]: `postTotalShares` amount of shares in the protocol after report
     *  [2]: `withdrawals` withdrawn from the withdrawals vault
     *  [3]: `elRewards` withdrawn from the execution layer rewards vault
     */
    function handleOracleReport(
        ReportValues memory _report
    ) external returns (uint256[4] memory) {
        Contracts memory contracts = _loadOracleReportContracts();

        ReportContext memory reportContext = _calculateOracleReportContext(contracts, _report);

        return _applyOracleReportContext(contracts, reportContext);
    }

    function _calculateOracleReportContext(
        Contracts memory _contracts,
        ReportValues memory _report
    ) internal view returns (ReportContext memory){
        // Take a snapshot of the current (pre-) state
        PreReportState memory pre = _snapshotPreReportState();

        // Calculate values to update
        CalculatedValues memory update = CalculatedValues(0,0,0,0,0,0,0,
            _getStakingRewardsDistribution(_contracts.stakingRouter), 0, 0, 0, 0, new uint256[](0));

        // Pre-calculate the ether to lock for withdrawal queue and shares to be burnt
        (
            update.etherToFinalizeWQ,
            update.sharesToFinalizeWQ
        ) = _calculateWithdrawals(_contracts, _report);

        // Take into account the balance of the newly appeared validators
        uint256 appearedValidators = _report.clValidators - pre.clValidators;
        update.principalClBalance = pre.clBalance + appearedValidators * DEPOSIT_SIZE;

        uint256 simulatedSharesToBurn; // shares that would be burned if no withdrawals are handled

        // Pre-calculate amounts to withdraw from ElRewardsVault and WithdrawalsVault
        (
            update.withdrawals,
            update.elRewards,
            simulatedSharesToBurn,
            update.totalSharesToBurn
        ) = _contracts.oracleReportSanityChecker.smoothenTokenRebase(
            pre.totalPooledEther,
            pre.totalShares,
            update.principalClBalance,
            _report.clBalance,
            _report.withdrawalVaultBalance,
            _report.elRewardsVaultBalance,
            _report.sharesRequestedToBurn,
            update.etherToFinalizeWQ,
            update.sharesToFinalizeWQ
        );

        update.sharesToBurnDueToWQThisReport = update.totalSharesToBurn - simulatedSharesToBurn;
        // TODO: check simulatedShareRate here ??

        // Pre-calculate total amount of protocol fees for this rebase
        uint256 externalShares = LIDO.getSharesByPooledEth(pre.externalEther);
        (
            ShareRate memory newShareRate,
            uint256 sharesToMintAsFees
        ) = _calculateShareRateAndFees(_report, pre, update, externalShares);
        update.sharesToMintAsFees = sharesToMintAsFees;

        update.externalEther = externalShares * newShareRate.eth / newShareRate.shares;

        update.postTotalShares = pre.totalShares // totalShares includes externalShares
            + update.sharesToMintAsFees
            - update.totalSharesToBurn;
        update.postTotalPooledEther = pre.totalPooledEther // was before the report
            + _report.clBalance + update.withdrawals + update.elRewards - update.principalClBalance // total rewards or penalty in Lido
            + update.externalEther - pre.externalEther // vaults rewards (or penalty)
            - update.etherToFinalizeWQ;

        update.lockedEther = _calculateVaultsRebase(newShareRate);

        // TODO: assert resuting shareRate == newShareRate

        return ReportContext(_report, pre, update);
    }

    function _snapshotPreReportState() internal view returns (PreReportState memory pre) {
        pre = PreReportState(0,0,0,0,0,0);
        (pre.depositedValidators, pre.clValidators, pre.clBalance) = LIDO.getBeaconStat();
        pre.totalPooledEther = LIDO.getTotalPooledEther();
        pre.totalShares = LIDO.getTotalShares();
        pre.externalEther = LIDO.getExternalEther();
    }

    /**
     * @dev return amount to lock on withdrawal queue and shares to burn
     * depending on the finalization batch parameters
     */
    function _calculateWithdrawals(
        Contracts memory _contracts,
        ReportValues memory _report
    ) internal view returns (uint256 etherToLock, uint256 sharesToBurn) {
        if (_report.withdrawalFinalizationBatches.length != 0 && !_contracts.withdrawalQueue.isPaused()) {
            _contracts.oracleReportSanityChecker.checkWithdrawalQueueOracleReport(
                _report.withdrawalFinalizationBatches[_report.withdrawalFinalizationBatches.length - 1],
                _report.timestamp
            );

            (etherToLock, sharesToBurn) = _contracts.withdrawalQueue.prefinalize(
                _report.withdrawalFinalizationBatches,
                _report.simulatedShareRate
            );
        }
    }

    function _calculateShareRateAndFees(
        ReportValues memory _report,
        PreReportState memory _pre,
        CalculatedValues memory _calculated,
        uint256 _externalShares
    ) internal pure returns (ShareRate memory shareRate, uint256 sharesToMintAsFees) {
        shareRate.shares = _pre.totalShares - _calculated.totalSharesToBurn - _externalShares;

        shareRate.eth = _pre.totalPooledEther - _pre.externalEther - _calculated.etherToFinalizeWQ;

        uint256 unifiedBalance = _report.clBalance + _calculated.withdrawals + _calculated.elRewards;

        // Don’t mint/distribute any protocol fee on the non-profitable Lido oracle report
        // (when consensus layer balance delta is zero or negative).
        // See LIP-12 for details:
        // https://research.lido.fi/t/lip-12-on-chain-part-of-the-rewards-distribution-after-the-merge/1625
        if (unifiedBalance > _calculated.principalClBalance) {
            uint256 totalRewards = unifiedBalance - _calculated.principalClBalance;
            uint256 totalFee = _calculated.rewardDistribution.totalFee;
            uint256 precision = _calculated.rewardDistribution.precisionPoints;
            uint256 feeEther = totalRewards * totalFee / precision;
            shareRate.eth += totalRewards - feeEther;

            // but we won't pay fees in ether, so we need to calculate how many shares we need to mint as fees
            sharesToMintAsFees = feeEther * shareRate.shares / shareRate.eth;
        } else {
            uint256 totalPenalty = _calculated.principalClBalance - unifiedBalance;
            shareRate.eth -= totalPenalty;
        }
    }

    function _applyOracleReportContext(
        Contracts memory _contracts,
        ReportContext memory _context
    ) internal returns (uint256[4] memory) {
        //TODO: custom errors
        require(msg.sender == _contracts.accountingOracleAddress, "APP_AUTH_FAILED");

        _checkAccountingOracleReport(_contracts, _context);

        uint256 lastWithdrawalRequestToFinalize;
        if (_context.update.sharesToFinalizeWQ > 0) {
            _contracts.burner.requestBurnShares(
                address(_contracts.withdrawalQueue), _context.update.sharesToFinalizeWQ
            );

            lastWithdrawalRequestToFinalize =
                _context.report.withdrawalFinalizationBatches[_context.report.withdrawalFinalizationBatches.length - 1];
        }

        LIDO.processClStateUpdate(
            _context.report.timestamp,
            _context.pre.clValidators,
            _context.report.clValidators,
            _context.report.clBalance,
            _context.update.externalEther
        );

        if (_context.update.totalSharesToBurn > 0) {
//            FIXME: expected to be called as StETH
            _contracts.burner.commitSharesToBurn(_context.update.totalSharesToBurn);
        }

        // Distribute protocol fee (treasury & node operators)
        if (_context.update.sharesToMintAsFees > 0) {
            _distributeFee(
                _contracts.stakingRouter,
                _context.update.rewardDistribution,
                _context.update.sharesToMintAsFees
            );
        }

        LIDO.collectRewardsAndProcessWithdrawals(
            _context.report.timestamp,
            _context.report.clBalance,
            _context.update.principalClBalance,
            _context.update.withdrawals,
            _context.update.elRewards,
            lastWithdrawalRequestToFinalize,
            _context.report.simulatedShareRate,
            _context.update.etherToFinalizeWQ
        );

        _updateVaults(
            _context.report.clBalances,
            _context.report.elBalances,
            _context.report.netCashFlows,
            _context.update.lockedEther
        );

        // TODO: vault fees

        // FIXME: Legacy Oracle call in fact, still in use? The event it fires was marked as deprecated.
        // _completeTokenRebase(
        //    _context,
        //    _contracts.postTokenRebaseReceiver
        // );

        LIDO.emitTokenRebase(
            _context.report.timestamp,
            _context.report.timeElapsed,
            _context.pre.totalShares,
            _context.pre.totalPooledEther,
            _context.update.postTotalShares,
            _context.update.postTotalPooledEther,
            _context.update.sharesToMintAsFees
        );

        if (_context.report.withdrawalFinalizationBatches.length != 0) {
            // TODO: Is there any sense to check if simulated == real on no withdrawals
            _contracts.oracleReportSanityChecker.checkSimulatedShareRate(
                _context.update.postTotalPooledEther,
                _context.update.postTotalShares,
                _context.update.etherToFinalizeWQ,
                _context.update.sharesToBurnDueToWQThisReport,
                _context.report.simulatedShareRate
            );
        }

        // TODO: check realPostTPE and realPostTS against calculated

        return [_context.update.postTotalPooledEther, _context.update.postTotalShares,
            _context.update.withdrawals, _context.update.elRewards];
    }


    /**
     * @dev Pass the provided oracle data to the sanity checker contract
     * Works with structures to overcome `stack too deep`
     */
    function _checkAccountingOracleReport(
        Contracts memory _contracts,
        ReportContext memory _context
    ) internal view {
        _contracts.oracleReportSanityChecker.checkAccountingOracleReport(
            _context.report.timestamp,
            _context.report.timeElapsed,
            _context.update.principalClBalance,
            _context.report.clBalance,
            _context.report.withdrawalVaultBalance,
            _context.report.elRewardsVaultBalance,
            _context.report.sharesRequestedToBurn,
            _context.pre.clValidators,
            _context.report.clValidators,
            _context.pre.depositedValidators
        );
    }

    /**
     * @dev Notify observers about the completed token rebase.
     * Emit events and call external receivers.
     */
    function _completeTokenRebase(
        ReportContext memory _context,
        IPostTokenRebaseReceiver _postTokenRebaseReceiver
    ) internal {
        if (address(_postTokenRebaseReceiver) != address(0)) {
            _postTokenRebaseReceiver.handlePostTokenRebase(
                _context.report.timestamp,
                _context.report.timeElapsed,
                _context.pre.totalShares,
                _context.pre.totalPooledEther,
                _context.update.postTotalShares,
                _context.update.postTotalPooledEther,
                _context.update.sharesToMintAsFees
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
        IOracleReportSanityChecker oracleReportSanityChecker;
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
            address postTokenRebaseReceiver, // TODO: Legacy Oracle? Still in use used?
            address stakingRouter
        ) = LIDO_LOCATOR.oracleReportComponents();

        return Contracts(
            accountingOracleAddress,
            IOracleReportSanityChecker(oracleReportSanityChecker),
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
}
