// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import { StakingVaultDeposit } from "./IStakingVault.sol";

interface IVaultControl {

    struct Report {
        uint128 totalValue;
        int128 inOutDelta;
    }

    /// @notice Obligations categories
    enum ObligationCategory {
        Withdrawal,
        TreasuryFees,
        NodeOperatorFees
    }

    // todo: optimize storage layout
    struct VaultSocket {
        // ### 1st slot
        /// @notice the address of the vault proxy contract connected to the hub
        address vault;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        // ### 2th slot
        /// @notice the address of the original vault owner
        address owner;
        /// @notice total number of stETH shares that the vault owes to Lido
        uint96 liabilityShares;
        // ### 3rd slot
        /// @notice amount of ETH that is locked on the vault and cannot be withdrawn by owner
        uint128 locked;
        /// @notice net difference between ether funded and withdrawn from the vault
        int128 inOutDelta;
        // ### 4th slot
        /// @notice the latest oracle report data for the vault
        Report report;
        // ### 5th slot
        /// @notice the timestamp of the report
        uint64 reportTimestamp;
        /// @notice share of ether that is locked on the vault as an additional reserve
        /// e.g RR=30% means that for 1stETH minted 1/(1-0.3)=1.428571428571428571 ETH is locked on the vault
        uint16 reserveRatioBP;
        /// @notice if vault's reserve decreases to this threshold, it should be force rebalanced
        uint16 forcedRebalanceThresholdBP;
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
        /// @notice if true, vault is disconnected and fee is not accrued
        bool pendingDisconnect;
        // UNUSED 143 bytes
        // ### 6th slot
        /// @notice obligations accrued on the vault
        mapping(ObligationCategory => uint256) outstandingObligations;
        // ### 7th slot
        /// @notice already settled obligations
        mapping(ObligationCategory => uint256) settledObligations;
    }

    function operatorGrid() external view returns (address);

    function vaultSocket(uint256 _index) external view returns (VaultSocket memory);

    function vaultSocket(address _vault) external view returns (VaultSocket memory);

    function rebalanceShortfall(address _vault) external view returns (uint256);

    function isReportFresh(address _vault) external view returns (bool);

    function unlocked(address _vault) external view returns (uint256);

    function totalValue(address _vault) external view returns (uint256);

    function setVaultOwner(address _vault, address _owner) external;

    function voluntaryDisconnect(address _vault) external;

    function fund(address _vault) external payable;

    function withdraw(address _vault, address _recipient, uint256 _ether) external;

    function rebalance(address _vault, uint256 _ether) external;

    function mintShares(address _vault, address _recipient, uint256 _amountOfShares) external;

    function burnShares(address _vault, uint256 _amountOfShares) external;

    function depositToBeaconChain(address _vault, StakingVaultDeposit[] calldata _deposits) external;

    function pauseBeaconChainDeposits(address _vault) external;

    function resumeBeaconChainDeposits(address _vault) external;

    function requestValidatorExit(address _vault, bytes calldata _pubkeys) external;

    function triggerValidatorWithdrawal(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable;
}
