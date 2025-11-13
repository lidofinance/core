// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

struct KeyData {
    bytes pubkey;
    uint256 keyIndex;
    uint256 operatorIndex;
    uint256 moduleId;
    uint256 balance;
}

interface IStakingModuleV2 {
    // Flow of creation of validators

    /// @notice Get Eth allocation for operators based on available eth for deposits and current operator balances
    /// @param depositAmount - Value available for deposit in module
    /// @return operatorIds - Array of operators ids
    /// @return allocations - Array of the allocations that can be deposited on operator in module opinion.
    function getAllocation(
        uint256 depositAmount
    ) external view returns (uint256[] memory operatorIds, uint256[] memory allocations);

    /// @notice Get public keys with it's deposit signatures
    /// @param operatorsIds - Array of operators ids
    /// @param counts - Array of amounts of keys to fetch from module for operators
    /// @return publicKeys Batch of the concatenated public validators keys
    /// @return signatures Batch of the concatenated deposit signatures for returned public keys
    function getOperatorAvailableKeys(
        uint256[] memory operatorsIds,
        uint256[] memory counts
    ) external view returns (bytes memory publicKeys, bytes memory signatures);

    // Top ups

    /// @notice Check keys belong to operator of module
    /// @param data - validator data
    function verifyKeys(KeyData[] calldata data) external view returns (bool);


    /// @notice Check keys belong to operator of module
    /// @param data - validator data
    
    function getKeysForTopUp(KeyData[] calldata data) external view returns (KeyData[] calldata wantToTopUp);

    /// @notice Get Eth allocation for operators based on available eth for deposits and current operator balances
    /// @param depositAmount - Value available for deposit in module
    /// @param operators - Array of operators ids
    /// @param topUpLimits - Array of max Eth values that can be deposited on operator based on CL balances on last finalized slot
    /// @return allocations - Array of the allocations that can be deposited on operator in module opinion.
    function getAllocation(
        uint256 depositAmount,
        uint256[] memory operators,
        uint256[] memory topUpLimits
    ) external view returns (uint256[] memory allocations);

    /// @notice Updates the effective balances for node operators
    /// @param operatorIds Encoded operator IDs
    /// @param effectiveBalances Encoded effective balances for the operators
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
