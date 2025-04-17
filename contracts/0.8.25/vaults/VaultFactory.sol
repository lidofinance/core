// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {PinnedBeaconProxy} from "./PinnedBeaconProxy.sol";

import {Permissions} from "./dashboard/Permissions.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {Dashboard} from "./dashboard/Dashboard.sol";

/**
 * @title VaultFactory
 * @author Lido
 * @notice The factory contract for StakingVaults
 */
contract VaultFactory {
    address public immutable LIDO_LOCATOR;
    address public immutable BEACON;
    address public immutable DASHBOARD_IMPL;

    /**
     * @param _lidoLocator The address of the LidoLocator contract
     * @param _beacon The address of the Beacon contract for StakingVaults
     * @param _dashboardImpl The address of the Dashboard implementation contract
     */
    constructor(address _lidoLocator, address _beacon, address _dashboardImpl) {
        if (_lidoLocator == address(0)) revert ZeroArgument("_lidoLocator");
        if (_beacon == address(0)) revert ZeroArgument("_beacon");
        if (_dashboardImpl == address(0)) revert ZeroArgument("_dashboardImpl");

        LIDO_LOCATOR = _lidoLocator;
        BEACON = _beacon;
        DASHBOARD_IMPL = _dashboardImpl;
    }

    /**
     * @notice Creates a new StakingVault and Dashboard contracts
     * @param _defaultAdmin The address of the default admin of the Dashboard
     * @param _nodeOperator The address of the node operator of the StakingVault
     * @param _nodeOperatorManager The address of the node operator manager in the Dashboard
     * @param _nodeOperatorFeeBP The node operator fee in basis points
     * @param _confirmExpiry The confirmation expiry in seconds
     * @param _roleAssignments The optional role assignments to be made
     * @param _extraParams The extra params for the StakingVault
     */
    function createVaultWithDashboard(
        address _defaultAdmin,
        address _nodeOperator,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry,
        Permissions.RoleAssignment[] calldata _roleAssignments,
        bytes calldata _extraParams
    ) external returns (IStakingVault vault, Dashboard dashboard) {
        vault = IStakingVault(address(new PinnedBeaconProxy(BEACON, "")));

        bytes memory immutableArgs = abi.encode(vault);
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(DASHBOARD_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(
            address(this),
            _nodeOperator,
            ILidoLocator(LIDO_LOCATOR).predepositGuarantee(),
            _extraParams
        );

        vault.authorizeLidoVaultHub();

        // transfer ownership of the vault back to the dashboard
        OwnableUpgradeable(address(vault)).transferOwnership(address(dashboard));

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

        emit VaultCreated(address(vault), address(dashboard));
        emit DashboardCreated(address(dashboard), _defaultAdmin);
    }

    /**
     * @notice Event emitted on a Vault creation
     * @param vault The address of the created Vault
     * @param owner The address of the owner of the Vault
     */
    event VaultCreated(address indexed vault, address indexed owner);

    /**
     * @notice Event emitted on a Dashboard creation
     * @param dashboard The address of the created Dashboard
     * @param admin The address of the Dashboard admin
     */
    event DashboardCreated(address indexed dashboard, address indexed admin);

    /**
     * @notice Error thrown for when a given value cannot be zero
     * @param argument Name of the argument
     */
    error ZeroArgument(string argument);
}