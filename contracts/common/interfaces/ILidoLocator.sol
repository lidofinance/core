// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24 <0.9.0;

interface ILidoLocator {
    function accountingOracle() external view returns(address);
    function depositSecurityModule() external view returns(address);
    function elRewardsVault() external view returns(address);
    function lido() external view returns(address);
    function oracleReportSanityChecker() external view returns(address);
    function burner() external view returns(address);
    function stakingRouter() external view returns(address);
    function treasury() external view returns(address);
    function validatorsExitBusOracle() external view returns(address);
    function withdrawalQueue() external view returns(address);
    function withdrawalVault() external view returns(address);
    function postTokenRebaseReceiver() external view returns(address);
    function oracleDaemonConfig() external view returns(address);
    function validatorExitDelayVerifier() external view returns (address);
    function triggerableWithdrawalsGateway() external view returns (address);
    function accounting() external view returns (address);
    function predepositGuarantee() external view returns (address);
    function wstETH() external view returns (address);
    function vaultHub() external view returns (address);
    function vaultFactory() external view returns (address);
    function lazyOracle() external view returns (address);
    function operatorGrid() external view returns (address);

    /// @notice Returns core Lido protocol component addresses in a single call
    /// @dev This function provides a gas-efficient way to fetch multiple component addresses in a single call
    function coreComponents() external view returns(
        address elRewardsVault,
        address oracleReportSanityChecker,
        address stakingRouter,
        address treasury,
        address withdrawalQueue,
        address withdrawalVault
    );

    /// @notice Returns addresses of components involved in processing oracle reports in the Lido contract
    /// @dev This function provides a gas-efficient way to fetch multiple component addresses in a single call
    function oracleReportComponents() external view returns(
        address accountingOracle,
        address oracleReportSanityChecker,
        address burner,
        address withdrawalQueue,
        address postTokenRebaseReceiver,
        address stakingRouter,
        address vaultHub
    );
}
