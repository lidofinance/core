// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

interface IStakingModuleV2 {
    // Top ups
    /// @notice Validates provided keys and calculates deposit allocations for top-up
    /// @dev Reverts if any key doesn't belong to the module or data is invalid
    /// @param depositAmount Total ether amount available for top-up (must be multiple of 1 gwei)
    /// @param pubkeys List of validator public keys to top up
    /// @param keyIndices Indices of keys within their respective operators
    /// @param operatorIds Node operator IDs that own the keys
    /// @param topUpLimits Maximum amount that can be deposited per key based on Consensus Layer data and  SR internal logic.
    /// @return allocations Amount to deposit to each corresponding key
    /// @dev allocations list can contain zero values
    /// @dev sum of allocations can be less or equal to depositAmount
    /// @dev Values depositAmount, topUpLimits, allocations are denominated in wei
    function allocateDeposits(
        uint256 depositAmount,
        bytes[] calldata pubkeys,
        uint256[] calldata keyIndices,
        uint256[] calldata operatorIds,
        uint256[] calldata topUpLimits
    ) external returns (uint256[] memory allocations);

    /// @notice returns the total amount of ETH staked in the module, in wei
    function getTotalModuleStake() external view returns (uint256);
}
