// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {PinnedBeaconProxy} from "./PinnedBeaconProxy.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {VaultHub} from "./VaultHub.sol";
import {Permissions} from "./dashboard/Permissions.sol";
import {Dashboard} from "./dashboard/Dashboard.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

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
     */
    function createVaultWithDashboard(
        address _defaultAdmin,
        address _nodeOperator,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry,
        Permissions.RoleAssignment[] calldata _roleAssignments
    ) external payable returns (IStakingVault vault, Dashboard dashboard) {
        // check if the msg.value is enough to cover the connect deposit
        ILidoLocator locator = ILidoLocator(LIDO_LOCATOR);
        if (msg.value < VaultHub(payable(locator.vaultHub())).CONNECT_DEPOSIT()) revert InsufficientFunds();

        // create the vault proxy
        vault = IStakingVault(address(new PinnedBeaconProxy(BEACON, "")));

        // create the dashboard proxy
        bytes memory immutableArgs = abi.encode(address(vault));
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(DASHBOARD_IMPL, immutableArgs)));

        // initialize StakingVault with the dashboard address as the owner
        vault.initialize(address(dashboard), _nodeOperator, locator.predepositGuarantee());

        // initialize Dashboard with the factory address as the default admin, grant optional roles and connect to VaultHub
        dashboard.initialize(address(this), _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);

        if (_roleAssignments.length > 0) dashboard.grantRoles(_roleAssignments);

        dashboard.connectToVaultHub{value: msg.value}();

        dashboard.grantRole(dashboard.DEFAULT_ADMIN_ROLE(), _defaultAdmin);
        dashboard.revokeRole(dashboard.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(vault));
        emit DashboardCreated(address(dashboard), address(vault), _defaultAdmin);
    }

    /**
     * @notice Creates a new StakingVault and Dashboard contracts without connecting to VaultHub
     * @param _defaultAdmin The address of the default admin of the Dashboard
     * @param _nodeOperator The address of the node operator of the StakingVault
     * @param _nodeOperatorManager The address of the node operator manager in the Dashboard
     * @param _nodeOperatorFeeBP The node operator fee in basis points
     * @param _confirmExpiry The confirmation expiry in seconds
     * @param _roleAssignments The optional role assignments to be made
     * @notice Only Node Operator managed roles can be assigned
     */
    function createVaultWithDashboardWithoutConnectingToVaultHub(
        address _defaultAdmin,
        address _nodeOperator,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry,
        Permissions.RoleAssignment[] calldata _roleAssignments
    ) external payable returns (IStakingVault vault, Dashboard dashboard) {
        ILidoLocator locator = ILidoLocator(LIDO_LOCATOR);

        // create the vault proxy
        vault = IStakingVault(address(new PinnedBeaconProxy(BEACON, "")));

        // create the dashboard proxy
        bytes memory immutableArgs = abi.encode(address(vault));
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(DASHBOARD_IMPL, immutableArgs)));

        // initialize StakingVault with the dashboard address as the owner
        vault.initialize(address(dashboard), _nodeOperator, locator.predepositGuarantee());

        // initialize Dashboard with the _defaultAdmin as the default admin, grant optional node operator managed roles
        dashboard.initialize(_defaultAdmin, address(this), _nodeOperatorFeeBP, _confirmExpiry);

        if (_roleAssignments.length > 0) dashboard.grantRoles(_roleAssignments);

        dashboard.grantRole(dashboard.NODE_OPERATOR_MANAGER_ROLE(), _nodeOperatorManager);
        dashboard.revokeRole(dashboard.NODE_OPERATOR_MANAGER_ROLE(), address(this));

        emit VaultCreated(address(vault));
        emit DashboardCreated(address(dashboard), address(vault), _defaultAdmin);
    }

    /**
     * @notice Event emitted on a Vault creation
     * @param vault The address of the created Vault
     */
    event VaultCreated(address indexed vault);

    /**
     * @notice Event emitted on a Dashboard creation
     * @param dashboard The address of the created Dashboard
     * @param vault The address of the created Vault
     * @param admin The address of the Dashboard admin
     */
    event DashboardCreated(address indexed dashboard, address indexed vault, address indexed admin);

    /**
     * @notice Error thrown for when a given value cannot be zero
     * @param argument Name of the argument
     */
    error ZeroArgument(string argument);

    /**
     * @notice Error thrown for when insufficient funds are provided
     */
    error InsufficientFunds();
}
