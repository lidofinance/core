// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.9;

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
    // uint256[] vaultValues;
    /// @notice in-out deltas (deposits - withdrawals) of each Lido vault
    // int256[] inOutDeltas;
    /// @notice overall vaults fees
    uint256 vaultsTotalFees;
    /// @notice Merkle Tree root of the vaults data.
    bytes32 vaultsDataTreeRoot;
    /// @notice CID of the published Merkle tree of the vault data.
    string vaultsDataTreeCid;
}
