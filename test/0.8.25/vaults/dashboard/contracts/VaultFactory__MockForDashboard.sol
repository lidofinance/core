// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {Dashboard} from "contracts/0.8.25/vaults/dashboard/Dashboard.sol";

contract VaultFactory__MockForDashboard is UpgradeableBeacon {
    address public immutable DASHBOARD_IMPL;
    address public immutable PREDEPOSIT_GUARANTEE;

    constructor(
        address _owner,
        address _stakingVaultImpl,
        address _dashboardImpl,
        address _predeposit_guarantee
    ) UpgradeableBeacon(_stakingVaultImpl, _owner) {
        if (_dashboardImpl == address(0)) revert ZeroArgument("_dashboardImpl");
        if (_predeposit_guarantee == address(0)) revert ZeroArgument("_predeposit_guarantee");

        DASHBOARD_IMPL = _dashboardImpl;
        PREDEPOSIT_GUARANTEE = _predeposit_guarantee;
    }

    function createVault(address _operator) external returns (IStakingVault vault, Dashboard dashboard) {
        vault = IStakingVault(address(new BeaconProxy(address(this), "")));

        bytes memory immutableArgs = abi.encode(vault);
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(DASHBOARD_IMPL, immutableArgs)));

        vault.initialize(address(dashboard), _operator, PREDEPOSIT_GUARANTEE);

        dashboard.initialize(address(this), _operator, 0, 7 days);
        dashboard.grantRole(dashboard.DEFAULT_ADMIN_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.FUND_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.WITHDRAW_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.MINT_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.BURN_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.REBALANCE_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.REQUEST_VALIDATOR_EXIT_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.VOLUNTARY_DISCONNECT_ROLE(), msg.sender);
        dashboard.revokeRole(dashboard.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(vault));
        emit DashboardCreated(address(dashboard), address(vault), msg.sender);
    }

    event VaultCreated(address indexed vault);

    event DashboardCreated(address indexed dashboard, address indexed vault, address indexed admin);

    error ZeroArgument(string);
}
