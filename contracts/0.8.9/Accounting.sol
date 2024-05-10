// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {IBurner} from "../common/interfaces/IBurner.sol";


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
    function getTotalShares() external view returns (uint256);
    function getBeaconStat() external view returns (
        uint256 depositedValidators,
        uint256 beaconValidators,
        uint256 beaconBalance
    );
    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _postClValidators,
        uint256 _postClBalance
    ) external;
    function collectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _adjustedPreCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256[] memory _withdrawalFinalizationBatches,
        uint256 _simulatedShareRate,
        uint256 _etherToLockOnWithdrawalQueue
    ) external;
    function mintShares(address _recipient, uint256 _sharesAmount) external;
    function burnShares(address _account, uint256 _sharesAmount) external;

    function emitTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external;
}

/**
 * The structure is used to aggregate the `handleOracleReport` provided data.
 *
 * @param _reportTimestamp the moment of the oracle report calculation
 * @param _timeElapsed seconds elapsed since the previous report calculation
 * @param _clValidators number of Lido validators on Consensus Layer
 * @param _clBalance sum of all Lido validators' balances on Consensus Layer
 * @param _withdrawalVaultBalance withdrawal vault balance on Execution Layer at `_reportTimestamp`
 * @param _elRewardsVaultBalance elRewards vault balance on Execution Layer at `_reportTimestamp`
 * @param _sharesRequestedToBurn shares requested to burn through Burner at `_reportTimestamp`
 * @param _withdrawalFinalizationBatches the ascendingly-sorted array of withdrawal request IDs obtained by calling
 * WithdrawalQueue.calculateFinalizationBatches. Empty array means that no withdrawal requests should be finalized
 * @param _simulatedShareRate share rate that was simulated by oracle when the report data created (1e27 precision)
 *
 * NB: `_simulatedShareRate` should be calculated off-chain by calling the method with `eth_call` JSON-RPC API
 * while passing empty `_withdrawalFinalizationBatches` and `_simulatedShareRate` == 0, plugging the returned values
 * to the following formula: `_simulatedShareRate = (postTotalPooledEther * 1e27) / postTotalShares`
 *
 */
struct ReportValues {
    // Oracle timings
    uint256 timestamp;
    uint256 timeElapsed;
    // CL values
    uint256 clValidators;
    uint256 clBalance;
    // EL values
    uint256 withdrawalVaultBalance;
    uint256 elRewardsVaultBalance;
    uint256 sharesRequestedToBurn;
    // Decision about withdrawals processing
    uint256[] withdrawalFinalizationBatches;
    uint256 simulatedShareRate;
}

/// This contract is responsible for handling oracle reports
contract Accounting {
    uint256 private constant DEPOSIT_SIZE = 32 ether;

    ILidoLocator public immutable LIDO_LOCATOR;
    ILido public immutable LIDO;

    constructor(address _lidoLocator){
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);
        LIDO = ILido(LIDO_LOCATOR.lido());
    }

    struct PreReportState {
        uint256 clValidators;
        uint256 clBalance;
        uint256 totalPooledEther;
        uint256 totalShares;
        uint256 depositedValidators;
    }

    struct CalculatedValues {
        uint256 withdrawals;
        uint256 elRewards;
        uint256 etherToLockOnWithdrawalQueue;
        uint256 sharesToBurnFromWithdrawalQueue;
        uint256 simulatedSharesToBurn;
        uint256 sharesToBurn;
        uint256 sharesToMintAsFees;
        uint256 adjustedPreClBalance;
        StakingRewardsDistribution moduleRewardDistribution;
    }

    struct ReportContext {
        ReportValues report;
        PreReportState pre;
        CalculatedValues update;
    }

    function calculateOracleReportContext(
        Contracts memory _contracts,
        ReportValues memory _report
    ) public view returns (ReportContext memory){
        // Take a snapshot of the current (pre-) state
        PreReportState memory pre = PreReportState(0,0,0,0,0);

        (pre.depositedValidators, pre.clValidators, pre.clBalance) = LIDO.getBeaconStat();
        pre.totalPooledEther = LIDO.getTotalPooledEther();
        pre.totalShares = LIDO.getTotalShares();

        // Calculate values to update
        CalculatedValues memory update = CalculatedValues(0,0,0,0,0,0,0,0,
            _getStakingRewardsDistribution(_contracts.stakingRouter));

        // Pre-calculate the ether to lock for withdrawal queue and shares to be burnt
        (
            update.etherToLockOnWithdrawalQueue,
            update.sharesToBurnFromWithdrawalQueue
        ) = _calculateWithdrawals(_contracts, _report);

        // Take into account the balance of the newly appeared validators
        uint256 appearedValidators = _report.clValidators - pre.clValidators;
        update.adjustedPreClBalance = pre.clBalance + appearedValidators * DEPOSIT_SIZE;

        // Pre-calculate amounts to withdraw from ElRewardsVault and WithdrawalsVault
        (
            update.withdrawals,
            update.elRewards,
            update.simulatedSharesToBurn,
            update.sharesToBurn
        ) = _contracts.oracleReportSanityChecker.smoothenTokenRebase(
            pre.totalPooledEther,
            pre.totalShares,
            update.adjustedPreClBalance,
            _report.clBalance,
            _report.withdrawalVaultBalance,
            _report.elRewardsVaultBalance,
            _report.sharesRequestedToBurn,
            update.etherToLockOnWithdrawalQueue,
            update.sharesToBurnFromWithdrawalQueue
        );

        // Pre-calculate total amount of protocol fees for this rebase
        update.sharesToMintAsFees = _calculateFees(
            _report,
            pre,
            update.withdrawals,
            update.elRewards,
            update.adjustedPreClBalance,
            update.moduleRewardDistribution);

        //TODO: Pre-calculate `postTotalPooledEther` and `postTotalShares`

        return ReportContext(_report, pre, update);
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
    ) internal returns (uint256[4] memory) {
        Contracts memory contracts = _loadOracleReportContracts();

        ReportContext memory reportContext = calculateOracleReportContext(contracts, _report);

        return _applyOracleReportContext(contracts, reportContext);
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

    function _calculateFees(
        ReportValues memory _report,
        PreReportState memory _pre,
        uint256 _withdrawnWithdrawals,
        uint256 _withdrawnELRewards,
        uint256 _adjustedPreClBalance,
        StakingRewardsDistribution memory _rewardsDistribution
    ) internal pure returns (uint256 sharesToMintAsFees) {
        uint256 postCLTotalBalance = _report.clBalance + _withdrawnWithdrawals;
        // Don’t mint/distribute any protocol fee on the non-profitable Lido oracle report
        // (when consensus layer balance delta is zero or negative).
        // See LIP-12 for details:
        // https://research.lido.fi/t/lip-12-on-chain-part-of-the-rewards-distribution-after-the-merge/1625
        if (postCLTotalBalance <= _adjustedPreClBalance) return 0;

        if (_rewardsDistribution.totalFee > 0) {
            uint256 totalRewards = postCLTotalBalance - _adjustedPreClBalance + _withdrawnELRewards;
            uint256 postTotalPooledEther = _pre.totalPooledEther + totalRewards;

            uint256 totalFee = _rewardsDistribution.totalFee;
            uint256 precisionPoints = _rewardsDistribution.precisionPoints;

            // We need to take a defined percentage of the reported reward as a fee, and we do
            // this by minting new token shares and assigning them to the fee recipients (see
            // StETH docs for the explanation of the shares mechanics). The staking rewards fee
            // is defined in basis points (1 basis point is equal to 0.01%, 10000 (TOTAL_BASIS_POINTS) is 100%).
            //
            // Since we are increasing totalPooledEther by totalRewards (totalPooledEtherWithRewards),
            // the combined cost of all holders' shares has became totalRewards StETH tokens more,
            // effectively splitting the reward between each token holder proportionally to their token share.
            //
            // Now we want to mint new shares to the fee recipient, so that the total cost of the
            // newly-minted shares exactly corresponds to the fee taken:
            //
            // totalPooledEtherWithRewards = _pre.totalPooledEther + totalRewards
            // shares2mint * newShareCost = (totalRewards * totalFee) / PRECISION_POINTS
            // newShareCost = totalPooledEtherWithRewards / (_pre.totalShares + shares2mint)
            //
            // which follows to:
            //
            //                        totalRewards * totalFee * _pre.totalShares
            // shares2mint = --------------------------------------------------------------
            //                 (totalPooledEtherWithRewards * PRECISION_POINTS) - (totalRewards * totalFee)
            //
            // The effect is that the given percentage of the reward goes to the fee recipient, and
            // the rest of the reward is distributed between token holders proportionally to their
            // token shares.

            sharesToMintAsFees = (totalRewards * totalFee * _pre.totalShares)
                / (postTotalPooledEther * precisionPoints - totalRewards * totalFee);
        }
    }

    function _applyOracleReportContext(
        Contracts memory _contracts,
        ReportContext memory _context
    ) internal returns (uint256[4] memory) {
        //TODO: custom errors
        require(msg.sender == _contracts.accountingOracleAddress, "APP_AUTH_FAILED");

        _checkAccountingOracleReport(_contracts, _context);

        LIDO.processClStateUpdate(
            _context.report.timestamp,
            _context.report.clValidators,
            _context.report.clBalance
        );

        if (_context.update.sharesToBurnFromWithdrawalQueue > 0) {
            _contracts.burner.requestBurnShares(
                address(_contracts.withdrawalQueue),
                _context.update.sharesToBurnFromWithdrawalQueue
            );
        }

        LIDO.collectRewardsAndProcessWithdrawals(
            _context.report.timestamp,
            _context.update.adjustedPreClBalance,
            _context.update.withdrawals,
            _context.update.elRewards,
            _context.report.withdrawalFinalizationBatches,
            _context.report.simulatedShareRate,
            _context.update.etherToLockOnWithdrawalQueue
        );

        if (_context.update.sharesToBurn > 0) {
            _contracts.burner.commitSharesToBurn(_context.update.sharesToBurn);
        }

        // Distribute protocol fee (treasury & node operators)
        if (_context.update.sharesToMintAsFees > 0) {
            _distributeFee(
                _contracts.stakingRouter,
                _context.update.moduleRewardDistribution,
                _context.update.sharesToMintAsFees
            );
        }

        (
            uint256 postTotalShares,
            uint256 postTotalPooledEther
        ) = _completeTokenRebase(
            _context,
            _contracts.postTokenRebaseReceiver
        );

        if (_context.report.withdrawalFinalizationBatches.length != 0) {
            _contracts.oracleReportSanityChecker.checkSimulatedShareRate(
                postTotalPooledEther,
                postTotalShares,
                _context.update.etherToLockOnWithdrawalQueue,
                _context.update.sharesToBurn - _context.update.simulatedSharesToBurn,
                _context.report.simulatedShareRate
            );
        }

        return [postTotalPooledEther, postTotalShares,
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
            _context.update.adjustedPreClBalance,
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
    ) internal returns (uint256 postTotalShares, uint256 postTotalPooledEther) {
        postTotalShares = LIDO.getTotalShares();
        postTotalPooledEther = LIDO.getTotalPooledEther();

        if (address(_postTokenRebaseReceiver) != address(0)) {
            _postTokenRebaseReceiver.handlePostTokenRebase(
                _context.report.timestamp,
                _context.report.timeElapsed,
                _context.pre.totalShares,
                _context.pre.totalPooledEther,
                postTotalShares,
                postTotalPooledEther,
                _context.update.sharesToMintAsFees
            );
        }

        LIDO.emitTokenRebase(
            _context.report.timestamp,
            _context.report.timeElapsed,
            _context.pre.totalShares,
            _context.pre.totalPooledEther,
            postTotalShares,
            postTotalPooledEther,
            _context.update.sharesToMintAsFees
        );
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
            address accountingOracle,
            address oracleReportSanityChecker,
            address burner,
            address withdrawalQueue,
            address postTokenRebaseReceiver,
            address stakingRouter
        ) = LIDO_LOCATOR.oracleReportComponents();

        return Contracts(
            accountingOracle,
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
