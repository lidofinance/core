// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract LidoLocator__MockMutable {
    struct Config {
        address accountingOracle;
        address depositSecurityModule;
        address elRewardsVault;
        address legacyOracle;
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
    }

    error ZeroAddress();

    address public accountingOracle;
    address public immutable depositSecurityModule;
    address public immutable elRewardsVault;
    address public immutable legacyOracle;
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

    /**
     * @notice declare service locations
     * @dev accepts a struct to avoid the "stack-too-deep" error
     * @param _config struct of addresses
     */
    constructor(Config memory _config) {
        accountingOracle = _assertNonZero(_config.accountingOracle);
        depositSecurityModule = _assertNonZero(_config.depositSecurityModule);
        elRewardsVault = _assertNonZero(_config.elRewardsVault);
        legacyOracle = _assertNonZero(_config.legacyOracle);
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
    }

    function coreComponents() external view returns (address, address, address, address, address, address) {
        return (elRewardsVault, oracleReportSanityChecker, stakingRouter, treasury, withdrawalQueue, withdrawalVault);
    }

    function oracleReportComponentsForLido()
        external
        view
        returns (address, address, address, address, address, address, address)
    {
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
