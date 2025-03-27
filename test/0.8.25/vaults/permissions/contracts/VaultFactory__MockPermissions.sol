// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";

import {Permissions__Harness} from "./Permissions__Harness.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

struct PermissionsConfig {
    address defaultAdmin;
    address nodeOperator;
    uint256 confirmExpiry;
    address funder;
    address withdrawer;
    address minter;
    address burner;
    address rebalancer;
    address depositPauser;
    address depositResumer;
    address exitRequester;
    address disconnecter;
}

contract VaultFactory__MockPermissions {
    address public immutable BEACON;
    address public immutable PERMISSIONS_IMPL;
    address public immutable VAULT_HUB;
    address public immutable DEPOSITOR;

    /// @param _beacon The address of the beacon contract
    /// @param _permissionsImpl The address of the Permissions implementation
    constructor(address _beacon, address _permissionsImpl, address _vaultHub, address _depositor) {
        if (_beacon == address(0)) revert ZeroArgument("_beacon");
        if (_permissionsImpl == address(0)) revert ZeroArgument("_permissionsImpl");
        if (_depositor == address(0)) revert ZeroArgument("_depositor");
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");

        BEACON = _beacon;
        PERMISSIONS_IMPL = _permissionsImpl;
        DEPOSITOR = _depositor;
        VAULT_HUB = _vaultHub;
    }

    /// @notice Creates a new StakingVault and Permissions contracts
    /// @param _permissionsConfig The params of permissions initialization
    /// @param _stakingVaultInitializerExtraParams The params of vault initialization
    function createVaultWithPermissions(
        PermissionsConfig calldata _permissionsConfig,
        bytes calldata _stakingVaultInitializerExtraParams
    ) external returns (IStakingVault vault, Permissions__Harness permissions) {
        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        // create Permissions
        bytes memory immutableArgs = abi.encode(vault);
        permissions = Permissions__Harness(payable(Clones.cloneWithImmutableArgs(PERMISSIONS_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(
            address(permissions),
            _permissionsConfig.nodeOperator,
            VAULT_HUB,
            DEPOSITOR,
            _stakingVaultInitializerExtraParams
        );

        // initialize Permissions
        permissions.initialize(address(this), _permissionsConfig.confirmExpiry);

        // setup roles
        permissions.grantRole(permissions.DEFAULT_ADMIN_ROLE(), _permissionsConfig.defaultAdmin);
        permissions.grantRole(permissions.FUND_ROLE(), _permissionsConfig.funder);
        permissions.grantRole(permissions.WITHDRAW_ROLE(), _permissionsConfig.withdrawer);
        permissions.grantRole(permissions.MINT_ROLE(), _permissionsConfig.minter);
        permissions.grantRole(permissions.BURN_ROLE(), _permissionsConfig.burner);
        permissions.grantRole(permissions.REBALANCE_ROLE(), _permissionsConfig.rebalancer);
        permissions.grantRole(permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), _permissionsConfig.depositPauser);
        permissions.grantRole(permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), _permissionsConfig.depositResumer);
        permissions.grantRole(permissions.REQUEST_VALIDATOR_EXIT_ROLE(), _permissionsConfig.exitRequester);
        permissions.grantRole(permissions.VOLUNTARY_DISCONNECT_ROLE(), _permissionsConfig.disconnecter);

        permissions.revokeRole(permissions.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(permissions), address(vault));
        emit PermissionsCreated(_permissionsConfig.defaultAdmin, address(permissions));
    }

    function revertCreateVaultWithPermissionsWithDoubleInitialize(
        PermissionsConfig calldata _permissionsConfig,
        bytes calldata _stakingVaultInitializerExtraParams
    ) external returns (IStakingVault vault, Permissions__Harness permissions) {
        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        // create Permissions
        bytes memory immutableArgs = abi.encode(vault);
        permissions = Permissions__Harness(payable(Clones.cloneWithImmutableArgs(PERMISSIONS_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(
            address(permissions),
            _permissionsConfig.nodeOperator,
            VAULT_HUB,
            DEPOSITOR,
            _stakingVaultInitializerExtraParams
        );

        // initialize Permissions
        permissions.initialize(address(this), _permissionsConfig.confirmExpiry);
        // should revert here
        permissions.initialize(address(this), _permissionsConfig.confirmExpiry);

        // setup roles
        permissions.grantRole(permissions.DEFAULT_ADMIN_ROLE(), _permissionsConfig.defaultAdmin);
        permissions.grantRole(permissions.FUND_ROLE(), _permissionsConfig.funder);
        permissions.grantRole(permissions.WITHDRAW_ROLE(), _permissionsConfig.withdrawer);
        permissions.grantRole(permissions.MINT_ROLE(), _permissionsConfig.minter);
        permissions.grantRole(permissions.BURN_ROLE(), _permissionsConfig.burner);
        permissions.grantRole(permissions.REBALANCE_ROLE(), _permissionsConfig.rebalancer);
        permissions.grantRole(permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), _permissionsConfig.depositPauser);
        permissions.grantRole(permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), _permissionsConfig.depositResumer);
        permissions.grantRole(permissions.REQUEST_VALIDATOR_EXIT_ROLE(), _permissionsConfig.exitRequester);
        permissions.grantRole(permissions.VOLUNTARY_DISCONNECT_ROLE(), _permissionsConfig.disconnecter);

        permissions.revokeRole(permissions.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(permissions), address(vault));
        emit PermissionsCreated(_permissionsConfig.defaultAdmin, address(permissions));
    }

    function revertCreateVaultWithPermissionsWithZeroDefaultAdmin(
        PermissionsConfig calldata _permissionsConfig,
        bytes calldata _stakingVaultInitializerExtraParams
    ) external returns (IStakingVault vault, Permissions__Harness permissions) {
        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        // create Permissions
        bytes memory immutableArgs = abi.encode(vault);
        permissions = Permissions__Harness(payable(Clones.cloneWithImmutableArgs(PERMISSIONS_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(
            address(permissions),
            _permissionsConfig.nodeOperator,
            VAULT_HUB,
            DEPOSITOR,
            _stakingVaultInitializerExtraParams
        );

        // should revert here
        permissions.initialize(address(0), _permissionsConfig.confirmExpiry);

        // setup roles
        permissions.grantRole(permissions.DEFAULT_ADMIN_ROLE(), _permissionsConfig.defaultAdmin);
        permissions.grantRole(permissions.FUND_ROLE(), _permissionsConfig.funder);
        permissions.grantRole(permissions.WITHDRAW_ROLE(), _permissionsConfig.withdrawer);
        permissions.grantRole(permissions.MINT_ROLE(), _permissionsConfig.minter);
        permissions.grantRole(permissions.BURN_ROLE(), _permissionsConfig.burner);
        permissions.grantRole(permissions.REBALANCE_ROLE(), _permissionsConfig.rebalancer);
        permissions.grantRole(permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), _permissionsConfig.depositPauser);
        permissions.grantRole(permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), _permissionsConfig.depositResumer);
        permissions.grantRole(permissions.REQUEST_VALIDATOR_EXIT_ROLE(), _permissionsConfig.exitRequester);
        permissions.grantRole(permissions.VOLUNTARY_DISCONNECT_ROLE(), _permissionsConfig.disconnecter);

        permissions.revokeRole(permissions.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(permissions), address(vault));
        emit PermissionsCreated(_permissionsConfig.defaultAdmin, address(permissions));
    }

    /**
     * @notice Event emitted on a Vault creation
     * @param owner The address of the Vault owner
     * @param vault The address of the created Vault
     */
    event VaultCreated(address indexed owner, address indexed vault);

    /**
     * @notice Event emitted on a Permissions creation
     * @param admin The address of the Permissions admin
     * @param permissions The address of the created Permissions
     */
    event PermissionsCreated(address indexed admin, address indexed permissions);

    /**
     * @notice Error thrown for when a given value cannot be zero
     * @param argument Name of the argument
     */
    error ZeroArgument(string argument);
}
