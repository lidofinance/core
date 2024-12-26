// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

/**
 * @title IStakingVault
 * @author Lido
 * @notice Interface for the `StakingVault` contract
 */
interface IStakingVault {
    /**
     * @notice Latest reported valuation and inOutDelta
     * @custom:valuation Aggregated validator balances plus the balance of `StakingVault`
     * @custom:inOutDelta Net difference between ether funded and withdrawn from `StakingVault`
     */
    struct Report {
        uint128 valuation;
        int128 inOutDelta;
    }

    function initialize(address _owner, address _operator, bytes calldata _params) external;
    function getInitializedVersion() external view returns (uint64);
    function vaultHub() external view returns (address);
    function operator() external view returns (address);
    function locked() external view returns (uint256);
    function valuation() external view returns (uint256);
    function isBalanced() external view returns (bool);
    function unlocked() external view returns (uint256);
    function inOutDelta() external view returns (int256);
    function withdrawalCredentials() external view returns (bytes32);
    function fund() external payable;
    function withdraw(address _recipient, uint256 _ether) external;
    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures,
        bytes calldata _sizes
    ) external;
    function requestValidatorExit(bytes calldata _pubkeys) external;
    function lock(uint256 _locked) external;
    function rebalance(uint256 _ether) external;
    function latestReport() external view returns (Report memory);
    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external;
}
