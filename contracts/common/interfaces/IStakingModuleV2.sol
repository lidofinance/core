// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

interface IStakingModuleV2 {
    // Top ups
    /// @notice Calculates deposit allocations for top-up and returns the public keys of the keys
    /// @dev Reverts if any key is not a deposited key of the module or data is invalid
    /// @param depositAmount Total ether amount available for top-up (must be multiple of 1 gwei)
    /// @param keyIndices Indices of keys within their respective operators
    /// @param operatorIds Node operator IDs that own the keys
    /// @param topUpLimits Maximum amount that can be deposited per key based on Consensus Layer data and  SR internal logic.
    /// @return pubkeys Public keys of the keys, read from the module storage
    /// @return allocations Amount to deposit to each corresponding key
    /// @dev pubkeys and allocations have the same length and order
    /// @dev allocations list can contain zero values
    /// @dev sum of allocations can be less or equal to depositAmount
    /// @dev Values depositAmount, topUpLimits, allocations are denominated in wei
    function allocateDeposits(
        uint256 depositAmount,
        uint256[] calldata keyIndices,
        uint256[] calldata operatorIds,
        uint256[] calldata topUpLimits
    ) external returns (bytes[] memory pubkeys, uint256[] memory allocations);

    /// @notice returns the total amount of ETH staked in the module, in wei
    function getTotalModuleStake() external view returns (uint256);
}
