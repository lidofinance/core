// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import "../../common/interfaces/ILidoLocator.sol";

contract LidoLocatorMock is ILidoLocator {
    struct ContractAddresses {
        address lido;
        address depositSecurityModule;
        address elRewardsVault;
        address accountingOracle;
        address legacyOracle;
        address oracleReportSanityChecker;
        address burner;
        address validatorsExitBusOracle;
        address stakingRouter;
        address treasury;
        address withdrawalQueue;
        address withdrawalVault;
        address postTokenRebaseReceiver;
        address oracleDaemonConfig;
    }

    address public immutable lido;
    address public immutable depositSecurityModule;
    address public immutable elRewardsVault;
    address public immutable accountingOracle;
    address public immutable legacyOracle;
    address public immutable oracleReportSanityChecker;
    address public immutable burner;
    address public immutable validatorsExitBusOracle;
    address public immutable stakingRouter;
    address public immutable treasury;
    address public immutable withdrawalQueue;
    address public immutable withdrawalVault;
    address public immutable postTokenRebaseReceiver;
    address public immutable oracleDaemonConfig;

    constructor (
        ContractAddresses memory addresses
    ) {
        lido = addresses.lido;
        depositSecurityModule = addresses.depositSecurityModule;
        elRewardsVault = addresses.elRewardsVault;
        accountingOracle = addresses.accountingOracle;
        legacyOracle = addresses.legacyOracle;
        oracleReportSanityChecker = addresses.oracleReportSanityChecker;
        burner = addresses.burner;
        validatorsExitBusOracle = addresses.validatorsExitBusOracle;
        stakingRouter = addresses.stakingRouter;
        treasury = addresses.treasury;
        withdrawalQueue = addresses.withdrawalQueue;
        withdrawalVault = addresses.withdrawalVault;
        postTokenRebaseReceiver = addresses.postTokenRebaseReceiver;
        oracleDaemonConfig = addresses.oracleDaemonConfig;
    }

    function coreComponents() external view returns(address,address,address,address,address,address) {
        return (
            elRewardsVault,
            oracleReportSanityChecker,
            stakingRouter,
            treasury,
            withdrawalQueue,
            withdrawalVault
        );
    }

    function oracleReportComponentsForLido() external view returns(
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
            elRewardsVault,
            oracleReportSanityChecker,
            burner,
            withdrawalQueue,
            withdrawalVault,
            postTokenRebaseReceiver
        );
    }
}
