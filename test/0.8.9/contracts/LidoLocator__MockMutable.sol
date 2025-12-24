// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {ILidoLocator} from "../../../contracts/common/interfaces/ILidoLocator.sol";

contract LidoLocator__MockMutable is ILidoLocator {
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
        address accounting;
        address predepositGuarantee;
        address wstETH;
        address vaultHub;
        address vaultFactory;
        address lazyOracle;
        address operatorGrid;
    }

    error ZeroAddress();

    address public accountingOracle;
    address public immutable depositSecurityModule;
    address public immutable elRewardsVault;
    address public immutable lido;
    address public immutable oracleReportSanityChecker;
    address public postTokenRebaseReceiver;
    address public immutable burner;
    address public immutable stakingRouter;
    address public immutable treasury;
    address public immutable validatorsExitBusOracle;
    address public immutable withdrawalQueue;
    address public immutable withdrawalVault;
    address public immutable oracleDaemonConfig;
    address public immutable validatorExitDelayVerifier;
    address public immutable triggerableWithdrawalsGateway;
    address public immutable accounting;
    address public immutable predepositGuarantee;
    address public immutable wstETH;
    address public immutable vaultHub;
    address public immutable vaultFactory;
    address public immutable lazyOracle;
    address public immutable operatorGrid;

    constructor(Config memory _config) {
        accountingOracle = _assertNonZero(_config.accountingOracle);
        depositSecurityModule = _assertNonZero(_config.depositSecurityModule);
        elRewardsVault = _assertNonZero(_config.elRewardsVault);
        lido = _assertNonZero(_config.lido);
        oracleReportSanityChecker = _assertNonZero(_config.oracleReportSanityChecker);
        postTokenRebaseReceiver = _assertNonZero(_config.postTokenRebaseReceiver);
        burner = _assertNonZero(_config.burner);
        stakingRouter = _assertNonZero(_config.stakingRouter);
        treasury = _assertNonZero(_config.treasury);
        validatorsExitBusOracle = _assertNonZero(_config.validatorsExitBusOracle);
        withdrawalQueue = _assertNonZero(_config.withdrawalQueue);
        withdrawalVault = _assertNonZero(_config.withdrawalVault);
        oracleDaemonConfig = _assertNonZero(_config.oracleDaemonConfig);
        validatorExitDelayVerifier = _assertNonZero(_config.validatorExitDelayVerifier);
        triggerableWithdrawalsGateway = _assertNonZero(_config.triggerableWithdrawalsGateway);
        accounting = _assertNonZero(_config.accounting);
        wstETH = _assertNonZero(_config.wstETH);
        predepositGuarantee = _assertNonZero(_config.predepositGuarantee);
        vaultHub = _assertNonZero(_config.vaultHub);
        vaultFactory = _assertNonZero(_config.vaultFactory);
        lazyOracle = _assertNonZero(_config.lazyOracle);
        operatorGrid = _assertNonZero(_config.operatorGrid);
    }

    function coreComponents() external view returns (address, address, address, address, address, address) {
        return (elRewardsVault, oracleReportSanityChecker, stakingRouter, treasury, withdrawalQueue, withdrawalVault);
    }

    function oracleReportComponents()
        external
        view
        returns (address, address, address, address, address, address, address)
    {
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

    function mock___updatePostTokenRebaseReceiver(address newAddress) external {
        postTokenRebaseReceiver = newAddress;
    }

    function mock___updateAccountingOracle(address newAddress) external {
        accountingOracle = newAddress;
    }
}
