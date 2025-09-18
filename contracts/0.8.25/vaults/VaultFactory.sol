// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {AccessControl} from "@openzeppelin/contracts-v5.2/access/AccessControl.sol";
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
contract VaultFactory is AccessControl {
    address public immutable LIDO_LOCATOR;
    address public immutable BEACON;

    /// @dev Role for managing dashboard implementation
    bytes32 public constant DASHBOARD_IMPL_MANAGER_ROLE = keccak256("VaultFactory.DashboardImplManagerRole");

    // The address of the Dashboard implementation contract
    address public dashboardImpl;

    /**
     * @notice mapping of vaults deployed by this factory
     * @dev Only the vaults deployed by this factory can be connected to VaultHub.
     *      This ensures that the vault storage has not been tampered with
     *      before connecting to VaultHub.
     */
    mapping(address vault => bool) public deployedVaults;

    /**
     * @param _lidoLocator The address of the LidoLocator contract
     * @param _beacon The address of the Beacon contract for StakingVaults
     * @param _dashboardImpl The address of the Dashboard implementation contract
     * @param _admin The address that will have the DEFAULT_ADMIN_ROLE and DASHBOARD_IMPL_MANAGER_ROLE
     */
    constructor(address _lidoLocator, address _beacon, address _dashboardImpl, address _admin) {
        if (_lidoLocator == address(0)) revert ZeroArgument("_lidoLocator");
        if (_beacon == address(0)) revert ZeroArgument("_beacon");
        if (_dashboardImpl == address(0)) revert ZeroArgument("_dashboardImpl");
        if (_admin == address(0)) revert ZeroArgument("_admin");

        LIDO_LOCATOR = _lidoLocator;
        BEACON = _beacon;
        dashboardImpl = _dashboardImpl;

        // Set up access control with explicit admin address
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(DASHBOARD_IMPL_MANAGER_ROLE, _admin);
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
        vault = IStakingVault(_deployVault());

        // create the dashboard proxy
        bytes memory immutableArgs = abi.encode(address(vault));
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(dashboardImpl, immutableArgs)));

        // initialize StakingVault with the dashboard address as the owner
        vault.initialize(address(dashboard), _nodeOperator, locator.predepositGuarantee());

        // initialize Dashboard with the factory address as the default admin, grant optional roles and connect to VaultHub
        dashboard.initialize(address(this), _nodeOperatorManager, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);

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
    ) external returns (IStakingVault vault, Dashboard dashboard) {
        ILidoLocator locator = ILidoLocator(LIDO_LOCATOR);

        // create the vault proxy
        vault = IStakingVault(_deployVault());

        // create the dashboard proxy
        bytes memory immutableArgs = abi.encode(address(vault));
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(dashboardImpl, immutableArgs)));

        // initialize StakingVault with the dashboard address as the owner
        vault.initialize(address(dashboard), _nodeOperator, locator.predepositGuarantee());

        // initialize Dashboard with the _defaultAdmin as the default admin, grant optional node operator managed roles
        dashboard.initialize(_defaultAdmin, address(this), _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);

        if (_roleAssignments.length > 0) dashboard.grantRoles(_roleAssignments);

        dashboard.grantRole(dashboard.NODE_OPERATOR_MANAGER_ROLE(), _nodeOperatorManager);
        dashboard.revokeRole(dashboard.NODE_OPERATOR_MANAGER_ROLE(), address(this));

        emit VaultCreated(address(vault));
        emit DashboardCreated(address(dashboard), address(vault), _defaultAdmin);
    }

    /**
     * @notice Creates a new Dashboard contract
     * @param _vault The address of the vault
     * @param _defaultAdmin The address of the default admin of the Dashboard
     * @param _nodeOperatorManager The address of the node operator manager in the Dashboard
     * @param _nodeOperatorFeeBP The node operator fee in basis points
     * @param _confirmExpiry The confirmation expiry in seconds
     * @param _roleAssignments The optional role assignments to be made
     */
    function createDashboard(
        address _vault,
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry,
        Permissions.RoleAssignment[] calldata _roleAssignments
    ) external returns (Dashboard dashboard) {
        // create the dashboard proxy
        bytes memory immutableArgs = abi.encode(address(_vault));
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(dashboardImpl, immutableArgs)));

        // initialize Dashboard with the factory address as the default admin, grant optional roles and connect to VaultHub
        dashboard.initialize(address(this), _nodeOperatorManager, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);

        if (_roleAssignments.length > 0) dashboard.grantRoles(_roleAssignments);

        dashboard.grantRole(dashboard.DEFAULT_ADMIN_ROLE(), _defaultAdmin);
        dashboard.revokeRole(dashboard.DEFAULT_ADMIN_ROLE(), address(this));

        emit DashboardCreated(address(dashboard), address(_vault), _defaultAdmin);
    }

    /**
     * @notice Sets the address of the Dashboard implementation contract
     * @param _dashboardImpl The address of the Dashboard implementation contract
     * @notice Only addresses with DASHBOARD_IMPL_MANAGER_ROLE can set the Dashboard implementation contract
     */
    function setDashboardImpl(address _dashboardImpl) external onlyRole(DASHBOARD_IMPL_MANAGER_ROLE) {
        if (_dashboardImpl == address(0)) revert ZeroArgument("_dashboardImpl");
        if (dashboardImpl == _dashboardImpl) revert DashboardImplAlreadySet();

        dashboardImpl = _dashboardImpl;

        emit DashboardImplSet(address(_dashboardImpl));
    }

    function _deployVault() internal returns (address vault) {
        vault = address(new PinnedBeaconProxy(BEACON, ""));
        deployedVaults[vault] = true;
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
     * @notice Event emitted on a Dashboard implementation contract setting
     * @param dashboardImpl The address of the set Dashboard implementation contract
     */
    event DashboardImplSet(address indexed dashboardImpl);

    /**
     * @notice Error thrown for when a given value cannot be zero
     * @param argument Name of the argument
     */
    error ZeroArgument(string argument);

    /**
     * @notice Error thrown for when insufficient funds are provided
     */
    error InsufficientFunds();


    /**
     * @notice Error thrown for when the Dashboard implementation contract is already set
     */
    error DashboardImplAlreadySet();
}
