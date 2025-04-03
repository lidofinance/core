// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {Permissions} from "./dashboard/Permissions.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {Dashboard} from "./dashboard/Dashboard.sol";

contract VaultFactory {
    address public immutable BEACON;
    address public immutable DASHBOARD_IMPL;

    /// @param _beacon The address of the beacon contract
    /// @param _dashboardImpl The address of the Dashboard implementation
    constructor(address _beacon, address _dashboardImpl) {
        if (_beacon == address(0)) revert ZeroArgument("_beacon");
        if (_dashboardImpl == address(0)) revert ZeroArgument("_dashboardImpl");

        BEACON = _beacon;
        DASHBOARD_IMPL = _dashboardImpl;
    }

    /// @notice Creates a new StakingVault and Dashboard contracts
    /// @param _defaultAdmin The address of the default admin
    /// @param _nodeOperator The address of the node operator
    /// @param _extraParams The params of vault creation
    /// @param _nodeOperatorManager The address of the node operator manager
    /// @param _nodeOperatorFeeBP The node operator fee in basis points
    /// @param _confirmExpiry The confirmation expiry
    function createVaultWithDashboard(
        address _defaultAdmin,
        address _nodeOperator,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry,
        Permissions.RoleAssignment[] calldata _roleAssignments,
        bytes calldata _extraParams
    ) external returns (IStakingVault vault, Dashboard dashboard) {
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        bytes memory immutableArgs = abi.encode(vault);
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(DASHBOARD_IMPL, immutableArgs)));

        vault.initialize(address(dashboard), _nodeOperator, _extraParams);

        // If there are extra role assignments to be made,
        // we initialize the dashboard with the VaultFactory as the default admin,
        // grant the roles and revoke the VaultFactory's admin role.
        // Otherwise, we initialize the dashboard with the default admin.
        if (_roleAssignments.length > 0) {
            dashboard.initialize(address(this), _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);
            // will revert if any role is not controlled by the default admin
            dashboard.grantRoles(_roleAssignments);

            dashboard.grantRole(dashboard.DEFAULT_ADMIN_ROLE(), _defaultAdmin);
            dashboard.revokeRole(dashboard.DEFAULT_ADMIN_ROLE(), address(this));
        } else {
            dashboard.initialize(_defaultAdmin, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);
        }

        emit VaultCreated(address(dashboard), address(vault));
        emit DashboardCreated(_defaultAdmin, address(dashboard));
    }

    /**
     * @notice Event emitted on a Vault creation
     * @param owner The address of the Vault owner
     * @param vault The address of the created Vault
     */
    event VaultCreated(address indexed owner, address indexed vault);

    /**
     * @notice Event emitted on a Dashboard creation
     * @param admin The address of the Dashboard admin
     * @param dashboard The address of the created Dashboard
     */
    event DashboardCreated(address indexed admin, address indexed dashboard);

    /**
     * @notice Error thrown for when a given value cannot be zero
     * @param argument Name of the argument
     */
    error ZeroArgument(string argument);
}
