// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* solhint-disable one-contract-per-file */

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

interface ILidoLocatorGloas {
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
    function accounting() external view returns (address);
    function predepositGuarantee() external view returns (address);
    function wstETH() external view returns (address);
    function vaultHub() external view returns (address);
    function vaultFactory() external view returns (address);
    function lazyOracle() external view returns (address);
    function operatorGrid() external view returns (address);
    function topUpGateway() external view returns (address);
    function validatorExitDelayVerifier() external view returns (address);
    function triggerableWithdrawalsGateway() external view returns (address);
    function consolidationGateway() external view returns (address);

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

/**
 * @title LidoLocatorGloas
 * @author mymphe
 * @notice Lido service locator
 * @dev configuration is stored as public immutables to reduce gas consumption
 * @dev Frozen copy of the pre-LIP-38 LidoLocator (with `validatorExitDelayVerifier`), used only to deploy
 *      the Gloas upgrade on forks until Gloas is enacted on-chain. Remove together with contracts/upgrade/gloas.
 */
contract LidoLocatorGloas is ILidoLocatorGloas {
    struct Config {
        address accountingOracle;
        address depositSecurityModule;
        address elRewardsVault;
        address lido;
        address oracleReportSanityChecker;
        address postTokenRebaseReceiver;
        address burner;
        address stakingRouter;
        address treasury;
        address validatorsExitBusOracle;
        address withdrawalQueue;
        address withdrawalVault;
        address oracleDaemonConfig;
        address validatorExitDelayVerifier;
        address triggerableWithdrawalsGateway;
        address consolidationGateway;
        address accounting;
        address predepositGuarantee;
        address wstETH;
        address vaultHub;
        address vaultFactory;
        address lazyOracle;
        address operatorGrid;
        address topUpGateway;
    }

    error ZeroAddress();

    //solhint-disable immutable-vars-naming
    address public immutable accountingOracle;
    address public immutable depositSecurityModule;
    address public immutable elRewardsVault;
    address public immutable lido;
    address public immutable oracleReportSanityChecker;
    address public immutable postTokenRebaseReceiver;
    address public immutable burner;
    address public immutable stakingRouter;
    address public immutable treasury;
    address public immutable validatorsExitBusOracle;
    address public immutable withdrawalQueue;
    address public immutable withdrawalVault;
    address public immutable oracleDaemonConfig;
    address public immutable validatorExitDelayVerifier;
    address public immutable triggerableWithdrawalsGateway;
    address public immutable consolidationGateway;
    address public immutable accounting;
    address public immutable predepositGuarantee;
    address public immutable wstETH;
    address public immutable vaultHub;
    address public immutable vaultFactory;
    address public immutable lazyOracle;
    address public immutable operatorGrid;
    address public immutable topUpGateway;
    //solhint-enable immutable-vars-naming

    /**
     * @notice declare service locations
     * @dev accepts a struct to avoid the "stack-too-deep" error
     * @param _config struct of addresses
     */
    constructor(Config memory _config) {
        accountingOracle = _assertNonZero(_config.accountingOracle);
        depositSecurityModule = _assertNonZero(_config.depositSecurityModule);
        elRewardsVault = _assertNonZero(_config.elRewardsVault);
        lido = _assertNonZero(_config.lido);
        oracleReportSanityChecker = _assertNonZero(_config.oracleReportSanityChecker);
        postTokenRebaseReceiver = _config.postTokenRebaseReceiver;
        burner = _assertNonZero(_config.burner);
        stakingRouter = _assertNonZero(_config.stakingRouter);
        treasury = _assertNonZero(_config.treasury);
        validatorsExitBusOracle = _assertNonZero(_config.validatorsExitBusOracle);
        withdrawalQueue = _assertNonZero(_config.withdrawalQueue);
        withdrawalVault = _assertNonZero(_config.withdrawalVault);
        oracleDaemonConfig = _assertNonZero(_config.oracleDaemonConfig);
        validatorExitDelayVerifier = _assertNonZero(_config.validatorExitDelayVerifier);
        triggerableWithdrawalsGateway = _assertNonZero(_config.triggerableWithdrawalsGateway);
        consolidationGateway = _assertNonZero(_config.consolidationGateway);
        accounting = _assertNonZero(_config.accounting);
        predepositGuarantee = _assertNonZero(_config.predepositGuarantee);
        wstETH = _assertNonZero(_config.wstETH);
        vaultHub = _assertNonZero(_config.vaultHub);
        vaultFactory = _assertNonZero(_config.vaultFactory);
        lazyOracle = _assertNonZero(_config.lazyOracle);
        operatorGrid = _assertNonZero(_config.operatorGrid);
        topUpGateway = _assertNonZero(_config.topUpGateway);
    }

    function coreComponents() external view returns (
        address,
        address,
        address,
        address,
        address,
        address
    ) {
        return (
            elRewardsVault,
            oracleReportSanityChecker,
            stakingRouter,
            treasury,
            withdrawalQueue,
            withdrawalVault
        );
    }

    function oracleReportComponents() external view override returns(
        address,
        address,
        address,
        address,
        address,
        address,
        address
    ) {
        return (
            accountingOracle,
            oracleReportSanityChecker,
            burner,
            withdrawalQueue,
            postTokenRebaseReceiver,
            stakingRouter,
            vaultHub
        );
    }

    function _assertNonZero(address _address) internal pure returns (address) {
        if (_address == address(0)) revert ZeroAddress();
        return _address;
    }
}
