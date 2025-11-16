// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

interface IStakingModuleV2 {
    // Top ups

    /// @notice Method to get from module public keys for top up and amount that should be topped up. Module also verify that keys belong to module and revert if got worng data
    /// @param depositAmount Deposit amount for top up
    /// @param packedPubkeys Packed list of pubkeys
    /// @param keyIndices List of keys' indices
    /// @param operatorIds List of operator indices
    /// @param topUpLimits List of amount of Eth that can be deposited to key based on Cl data and SR logic
    function obtainDepositData(
        uint256 depositAmount,
        bytes calldata packedPubkeys,
        uint256[] calldata keyIndices,
        uint256[] calldata operatorIds,
        uint256[] calldata topUpLimits 
    ) external returns (
        bytes[] memory publicKeys, 
        uint256[] memory allocations
    );
    

    /// @notice Updates the effective balances for node operators
    /// @param operatorIds Encoded operator IDs
    /// @param effectiveBalances Encoded effective balances for the operators
    /// @dev TODO: in document there are three paramaters, third one is a refSlot
    function updateOperatorBalances(
        bytes calldata operatorIds,
        bytes calldata effectiveBalances
    ) external;

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
