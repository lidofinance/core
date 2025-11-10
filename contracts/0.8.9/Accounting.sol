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

    /// @notice snapshot of the protocol state that may be changed during the report
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
        uint256 withdrawalsVaultTransfer;
        /// @notice amount of ether to collect from ELRewardsVault to the buffer
        uint256 elRewardsVaultTransfer;
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
        FeeDistribution feeDistribution;
        /// @notice amount of CL ether that is not rewards earned during this report period
        /// the sum of CL balance on the previous report and the amount of fresh deposits since then
        uint256 principalClBalance;
        /// @notice total number of stETH shares before the report is applied
        uint256 preTotalShares;
        /// @notice amount of ether under the protocol before the report is applied
        uint256 preTotalPooledEther;
        /// @notice total number of internal (not backed by vaults) stETH shares after the report is applied
        uint256 postInternalShares;
        /// @notice amount of ether under the protocol after the report is applied
        uint256 postInternalEther;
        /// @notice total number of stETH shares after the report is applied
        uint256 postTotalShares;
        /// @notice amount of ether under the protocol after the report is applied
        uint256 postTotalPooledEther;
    }

    /// @notice precalculated numbers of shares that should be minted as fee to NO
    /// via StakingModules and to Lido protocol treasury
    struct FeeDistribution {
        address[] moduleFeeRecipients;
        uint256[] moduleIds;
        uint256[] moduleSharesToMint;
        uint256 treasurySharesToMint;
    }

    /// @notice deposit size in wei (for pre-maxEB accounting)
    uint256 private constant DEPOSIT_SIZE = 32 ether;

    ILidoLocator public immutable LIDO_LOCATOR;
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
    /// This a initial part of Accounting Oracle flow:
    /// 1. simulate the report without any WQ processing (withdrawalFinalizationBatches.length == 0)
    /// 2. calculate `simulatedShareRate` (simulatedTotalPooledEther * 1e27 / simulatedTotalShares)
    /// 3. calculate `withdrawalFinalizationBatches` (WithdrawalQueue.calculateFinalizationBatches) using this `simulatedShareRate`
    /// 4. submit the report with provided `withdrawalFinalizationBatches` and `simulatedShareRate`
    /// @param _report report values
    function simulateOracleReport(
        ReportValues calldata _report
    ) external view returns (CalculatedValues memory update) {
        Contracts memory contracts = _loadOracleReportContracts();

        PreReportState memory pre = _snapshotPreReportState(contracts, true);

        return _simulateOracleReport(contracts, pre, _report);
    }

    /// @notice Updates accounting states, collects and distributes rewards, performs withdrawal requests finalization
    /// @dev periodically called by the AccountingOracle contract
    function handleOracleReport(ReportValues calldata _report) external {
        Contracts memory contracts = _loadOracleReportContracts();
        if (msg.sender != contracts.accountingOracle) revert NotAuthorized("handleOracleReport", msg.sender);

        PreReportState memory pre = _snapshotPreReportState(contracts, false);
        CalculatedValues memory update = _simulateOracleReport(contracts, pre, _report);
        _applyOracleReportContext(contracts, _report, pre, update);
    }

    /// @dev reads the current state of the protocol to the memory
    function _snapshotPreReportState(Contracts memory _contracts, bool isSimulation) internal view returns (PreReportState memory pre) {
        (pre.depositedValidators, pre.clValidators, pre.clBalance) = LIDO.getBeaconStat();
        pre.totalPooledEther = LIDO.getTotalPooledEther();
        pre.totalShares = LIDO.getTotalShares();
        pre.externalShares = LIDO.getExternalShares();
        pre.externalEther = LIDO.getExternalEther();

        if (isSimulation) {
            // for simulation we specifically fetch the current value, because during the refSlot `LastRefSlot` method
            // will return the previous refSlot value, but Oracle use simulation to gather the current refSlot info
            pre.badDebtToInternalize = _contracts.vaultHub.badDebtToInternalize();
        } else {
            pre.badDebtToInternalize =  _contracts.vaultHub.badDebtToInternalizeForLastRefSlot();
        }
    }

    /// @dev calculates all the state changes that is required to apply the report
    function _simulateOracleReport(
        Contracts memory _contracts,
        PreReportState memory _pre,
        ReportValues calldata _report
    ) internal view returns (CalculatedValues memory update) {
        update.preTotalShares = _pre.totalShares;
        update.preTotalPooledEther = _pre.totalPooledEther;

        // Get the ether to lock for withdrawal queue and shares to move to Burner to finalize requests
        (update.etherToFinalizeWQ, update.sharesToFinalizeWQ) = _calculateWithdrawals(
            _contracts,
            _report
        );

        // Principal CL balance is the sum of the current CL balance and
        // validator deposits during this report
        // TODO: to support maxEB we need to get rid of validator counting
        update.principalClBalance = _pre.clBalance + (_report.clValidators - _pre.clValidators) * DEPOSIT_SIZE;

        // Limit the rebase to avoid oracle frontrunning
        // by leaving some ether to sit in EL rewards vault or withdrawals vault
        // and/or leaving some shares unburnt on Burner to be processed on future reports
        (
            update.withdrawalsVaultTransfer,
            update.elRewardsVaultTransfer,
            update.sharesToBurnForWithdrawals,
            update.totalSharesToBurn // shares to burn from Burner balance
        ) = _contracts.oracleReportSanityChecker.smoothenTokenRebase(
            _pre.totalPooledEther - _pre.externalEther, // we need to change the base as shareRate is now calculated on
            _pre.totalShares - _pre.externalShares,     // internal ether and shares, but inside it's still total
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
            + _report.clBalance + update.withdrawalsVaultTransfer - update.principalClBalance
            + update.elRewardsVaultTransfer
            - update.etherToFinalizeWQ;

        // Pre-calculate total amount of protocol fees as the amount of shares that will be minted to pay it
        (update.sharesToMintAsFees, update.feeDistribution) = _calculateProtocolFees(
            _contracts.stakingRouter,
            _report,
             update,
            postInternalSharesBeforeFees
        );

        update.postInternalShares = postInternalSharesBeforeFees + update.sharesToMintAsFees + _pre.badDebtToInternalize;
        uint256 postExternalShares = _pre.externalShares - _pre.badDebtToInternalize; // can't underflow by design

        update.postTotalShares = update.postInternalShares + postExternalShares;
        update.postTotalPooledEther = update.postInternalEther
            + postExternalShares * update.postInternalEther / update.postInternalShares;
    }

    /// @dev return amount to lock on withdrawal queue and shares to burn depending on the finalization batch parameters
    function _calculateWithdrawals(
        Contracts memory _contracts,
        ReportValues calldata _report
    ) internal view returns (uint256 etherToLock, uint256 sharesToBurn) {
        if (_report.withdrawalFinalizationBatches.length != 0 && !_contracts.withdrawalQueue.isPaused()) {
            (etherToLock, sharesToBurn) = _contracts.withdrawalQueue.prefinalize(
                _report.withdrawalFinalizationBatches,
                _report.simulatedShareRate
            );
        }
    }

    /// @return sharesToMintAsFees total number of shares to be minted as Lido Core fee
    /// @return feeDistribution the number of shares that is minted to each module or treasury
    function _calculateProtocolFees(
        StakingRouter _stakingRouter,
        ReportValues calldata _report,
        CalculatedValues memory _update,
        uint256 _internalSharesBeforeFees
    ) internal view returns (uint256 sharesToMintAsFees, FeeDistribution memory feeDistribution) {
        (
            address[] memory recipients,
            uint256[] memory stakingModuleIds,
            uint96[] memory stakingModuleFees,
            uint96 totalFee,
            uint256 precisionPoints
        ) = _stakingRouter.getStakingRewardsDistribution();

        assert(recipients.length == stakingModuleIds.length);
        assert(stakingModuleIds.length == stakingModuleFees.length);

        sharesToMintAsFees = _calculateTotalProtocolFeeShares(
            _report,
            _update,
            _internalSharesBeforeFees,
            totalFee,
            precisionPoints
        );

        if (sharesToMintAsFees > 0) {
            feeDistribution.moduleFeeRecipients = recipients;
            feeDistribution.moduleIds = stakingModuleIds;

            (
                feeDistribution.moduleSharesToMint,
                feeDistribution.treasurySharesToMint
            ) = _calculateFeeDistribution(
                stakingModuleFees,
                totalFee,
                sharesToMintAsFees
            );
        }
    }

    /// @dev calculates shares that are minted as the protocol fees
    function _calculateTotalProtocolFeeShares(
        ReportValues calldata _report,
        CalculatedValues memory _update,
        uint256 _internalSharesBeforeFees,
        uint256 _totalFee,
        uint256 _feePrecisionPoints
    ) internal pure returns (uint256 sharesToMintAsFees) {
        // we are calculating the share rate equal to the post-rebase share rate
        // but with fees taken as ether deduction instead of minting shares
        // to learn the amount of shares we need to mint to compensate for this fee

        uint256 unifiedClBalance = _report.clBalance + _update.withdrawalsVaultTransfer;
        // Don't mint/distribute any protocol fee on the non-profitable Lido oracle report
        // (when consensus layer balance delta is zero or negative).
        // See LIP-12 for details:
        // https://research.lido.fi/t/lip-12-on-chain-part-of-the-rewards-distribution-after-the-merge/1625
        if (unifiedClBalance > _update.principalClBalance) {
            uint256 totalRewards = unifiedClBalance - _update.principalClBalance + _update.elRewardsVaultTransfer;
            // amount of fees in ether
            uint256 feeEther = (totalRewards * _totalFee) / _feePrecisionPoints;
            // but we won't pay fees in ether, so we need to calculate how many shares we need to mint as fees
            // using the share rate that takes fees into account
            // the share rate is the same as the post-rebase share rate
            // but with fees taken as ether deduction instead of minting shares
            // to learn the amount of shares we need to mint to compensate for this fee
            sharesToMintAsFees = (feeEther * _internalSharesBeforeFees) / (_update.postInternalEther - feeEther);
        }
    }

    function _calculateFeeDistribution(
        uint96[] memory stakingModuleFees,
        uint96 _totalFee,
        uint256 _totalSharesToMintAsFees
    ) internal pure returns (uint256[] memory moduleSharesToMint, uint256 treasurySharesToMint) {
        assert(_totalFee > 0);

        uint256 length = stakingModuleFees.length;
        moduleSharesToMint = new uint256[](length);

        uint256 totalModuleFeeShares = 0;

        for (uint256 i; i < stakingModuleFees.length; ++i) {
            uint256 moduleFee = stakingModuleFees[i];
            if (moduleFee > 0) {
                uint256 moduleFeeShares = (_totalSharesToMintAsFees * moduleFee) / _totalFee;
                totalModuleFeeShares += moduleFeeShares;
                moduleSharesToMint[i] = moduleFeeShares;
            }
        }

        treasurySharesToMint = _totalSharesToMintAsFees - totalModuleFeeShares;
    }

    /// @dev applies the precalculated changes to the protocol state
    function _applyOracleReportContext(
        Contracts memory _contracts,
        ReportValues calldata _report,
        PreReportState memory _pre,
        CalculatedValues memory _update
    ) internal {
        _sanityChecks(_contracts, _report, _pre, _update);

        uint256 lastWithdrawalRequestToFinalize;
        if (_update.sharesToFinalizeWQ > 0) {
            _contracts.burner.requestBurnShares(address(_contracts.withdrawalQueue), _update.sharesToFinalizeWQ);

            lastWithdrawalRequestToFinalize = _report.withdrawalFinalizationBatches[
                _report.withdrawalFinalizationBatches.length - 1
            ];
        }

        LIDO.processClStateUpdate(_report.timestamp, _pre.clValidators, _report.clValidators, _report.clBalance);

        if (_pre.badDebtToInternalize > 0) {
            _contracts.vaultHub.decreaseInternalizedBadDebt(_pre.badDebtToInternalize);
            LIDO.internalizeExternalBadDebt(_pre.badDebtToInternalize);
        }

        if (_update.totalSharesToBurn > 0) {
            _contracts.burner.commitSharesToBurn(_update.totalSharesToBurn);
        }

        LIDO.collectRewardsAndProcessWithdrawals(
            _report.timestamp,
            _report.clBalance,
            _update.principalClBalance,
            _update.withdrawalsVaultTransfer,
            _update.elRewardsVaultTransfer,
            lastWithdrawalRequestToFinalize,
            _report.simulatedShareRate,
            _update.etherToFinalizeWQ
        );

        if (_update.sharesToMintAsFees > 0) {
            _distributeFee(_update.feeDistribution);
            // important to have this callback last for modules to have updated state
            _contracts.stakingRouter.reportRewardsMinted(
                _update.feeDistribution.moduleIds,
                _update.feeDistribution.moduleSharesToMint
            );
        }

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
    function _sanityChecks(
        Contracts memory _contracts,
        ReportValues calldata _report,
        PreReportState memory _pre,
        CalculatedValues memory _update
    ) internal {
        if (_report.timestamp >= block.timestamp) revert IncorrectReportTimestamp(_report.timestamp, block.timestamp);
        if (_report.clValidators < _pre.clValidators || _report.clValidators > _pre.depositedValidators) {
            revert IncorrectReportValidators(_report.clValidators, _pre.clValidators, _pre.depositedValidators);
        }

        // Oracle should consider this limitation:
        // During the AO report the ether to finalize the WQ cannot be greater or equal to `simulatedPostInternalEther`
        if (_update.postInternalShares == 0) revert InternalSharesCantBeZero();

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
            _contracts.oracleReportSanityChecker.checkSimulatedShareRate(
                _update.postInternalEther,
                _update.postInternalShares,
                _update.etherToFinalizeWQ,
                _update.sharesToBurnForWithdrawals,
                _report.simulatedShareRate
            );
            _contracts.oracleReportSanityChecker.checkWithdrawalQueueOracleReport(
                _report.withdrawalFinalizationBatches[_report.withdrawalFinalizationBatches.length - 1],
                _report.timestamp
            );
        }
    }

    /// @dev mints protocol fees to the treasury and node operators and calls back to stakingRouter
    function _distributeFee(FeeDistribution memory _feeDistribution) internal {
        address[] memory recipients = _feeDistribution.moduleFeeRecipients;
        uint256[] memory sharesToMint = _feeDistribution.moduleSharesToMint;
        uint256 length = recipients.length;

        for (uint256 i; i < length; ++i) {
            uint256 moduleShares = sharesToMint[i];
            if (moduleShares > 0) {
                LIDO.mintShares(recipients[i], moduleShares);
            }
        }

        uint256 treasuryShares = _feeDistribution.treasurySharesToMint;
        if (treasuryShares > 0) { // zero is an edge case when all fees goes to modules
            LIDO.mintShares(LIDO_LOCATOR.treasury(), treasuryShares);
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
                IVaultHub(vaultHub)
            );
    }

    error NotAuthorized(string operation, address addr);
    error IncorrectReportTimestamp(uint256 reportTimestamp, uint256 upperBoundTimestamp);
    error IncorrectReportValidators(uint256 reportValidators, uint256 minValidators, uint256 maxValidators);
    error InternalSharesCantBeZero();
}
