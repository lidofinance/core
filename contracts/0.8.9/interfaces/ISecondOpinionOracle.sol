// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

/// @title Second Opinion Oracle interface for Lido. See LIP-23 for details.
interface ISecondOpinionOracle {
    /// @notice Returns second opinion report for the given reference slot
    /// @param refSlot is a reference slot to return report for
    /// @return success shows whether the report was successfully generated
    /// @return clBalanceGwei is a balance of the consensus layer in Gwei for the ref slot
    /// @return withdrawalVaultBalanceWei is a balance of the withdrawal vault in Wei for the ref slot
    /// @return totalDepositedValidators is a total number of validators deposited with Lido
    /// @return totalExitedValidators is a total number of Lido validators in the EXITED state
    function getReport(uint256 refSlot)
        external
        view
        returns (
            bool success,
            uint256 clBalanceGwei,
            uint256 withdrawalVaultBalanceWei,
            uint256 totalDepositedValidators,
            uint256 totalExitedValidators
        );
}

