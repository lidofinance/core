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
    /// @return publicKeys Validated list of public keys eligible for top-up
    /// @return allocations Amount to deposit to each corresponding key
    /// @dev Values depositAmount, topUpLimits, allocations are denominated in wei
    function obtainDepositData(
        uint256 depositAmount,
        bytes[] calldata pubkeys,
        uint256[] calldata keyIndices,
        uint256[] calldata operatorIds,
        uint256[] calldata topUpLimits
    ) external returns (bytes[] memory publicKeys, uint256[] memory allocations);

    /// @notice Updates the effective balances for node operators
    /// @param operatorIds Encoded operator IDs
    /// @param effectiveBalances Encoded effective balances for the operators
    /// @dev TODO: in document there are three paramaters, third one is a refSlot
    function updateOperatorBalances(bytes calldata operatorIds, bytes calldata effectiveBalances) external;

    // TODO: uncomment after devnet-0 and first v2 module implementation
    // /// @notice Returns the staking module summary with balance information
    // /// @return totalExitedValidators Total number of exited validators
    // /// @return totalDepositedValidators Total number of deposited validators
    // /// @return depositableValidatorsCount Number of validators available for deposit
    // /// @return totalEffectiveBalance Total effective balance of all validators (new field for v2)
    // function getStakingModuleSummary() external view returns (
    //     uint256 totalExitedValidators,
    //     uint256 totalDepositedValidators,
    //     uint256 depositableValidatorsCount,
    //     uint256 totalEffectiveBalance
    // );
}
