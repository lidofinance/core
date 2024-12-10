// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.0.2/proxy/Clones.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {Dashboard} from "contracts/0.8.25/vaults/Dashboard.sol";

pragma solidity 0.8.25;

contract VaultFactory__MockForDashboard is UpgradeableBeacon {
    address public immutable dashboardImpl;

    constructor(
        address _owner,
        address _stakingVaultImpl,
        address _dashboardImpl
    ) UpgradeableBeacon(_stakingVaultImpl, _owner) {
        if (_dashboardImpl == address(0)) revert ZeroArgument("_dashboardImpl");

        dashboardImpl = _dashboardImpl;
    }

    function createVault() external returns (IStakingVault vault, Dashboard dashboard) {
        vault = IStakingVault(address(new BeaconProxy(address(this), "")));

        dashboard = Dashboard(Clones.clone(dashboardImpl));

        dashboard.initialize(msg.sender, address(vault));
        vault.initialize(address(dashboard), "");

        emit VaultCreated(address(dashboard), address(vault));
        emit DashboardCreated(msg.sender, address(dashboard));
    }

    /**
     * @notice Event emitted on a Vault creation
     * @param owner The address of the Vault owner
     * @param vault The address of the created Vault
     */
    event VaultCreated(address indexed owner, address indexed vault);

    /**
     * @notice Event emitted on a Delegation creation
     * @param admin The address of the Delegation admin
     * @param dashboard The address of the created Dashboard
     */
    event DashboardCreated(address indexed admin, address indexed dashboard);

    error ZeroArgument(string);
}
