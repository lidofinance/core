// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

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
    address pdgCompensator;
    address unknownValidatorProver;
    address unguaranteedBeaconChainDepositor;
    address validatorExitRequester;
    address validatorWithdrawalTriggerer;
    address disconnecter;
    address tierChanger;
}

contract VaultFactory__MockPermissions {
    address public immutable BEACON;
    address public immutable PERMISSIONS_IMPL;
    address public immutable PREDEPOSIT_GUARANTEE;

    /// @param _beacon The address of the beacon contract
    /// @param _permissionsImpl The address of the Permissions implementation
    constructor(address _beacon, address _permissionsImpl, address _predeposit_guarantee) {
        if (_beacon == address(0)) revert ZeroArgument("_beacon");
        if (_permissionsImpl == address(0)) revert ZeroArgument("_permissionsImpl");
        if (_predeposit_guarantee == address(0)) revert ZeroArgument("_predeposit_guarantee");

        BEACON = _beacon;
        PERMISSIONS_IMPL = _permissionsImpl;
        PREDEPOSIT_GUARANTEE = _predeposit_guarantee;
    }

    /// @notice Creates a new StakingVault and Permissions contracts
    /// @param _permissionsConfig The params of permissions initialization
    function createVaultWithPermissions(
        PermissionsConfig calldata _permissionsConfig
    ) external returns (IStakingVault vault, Permissions__Harness permissions) {
        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        // create Permissions
        bytes memory immutableArgs = abi.encode(vault);
        permissions = Permissions__Harness(payable(Clones.cloneWithImmutableArgs(PERMISSIONS_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(address(permissions), _permissionsConfig.nodeOperator, PREDEPOSIT_GUARANTEE);

        // initialize Permissions
        permissions.initialize(address(this), _permissionsConfig.confirmExpiry);

        // setup roles
        _setupRoles(permissions, _permissionsConfig);

        permissions.revokeRole(permissions.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(permissions), address(vault));
        emit PermissionsCreated(_permissionsConfig.defaultAdmin, address(permissions));
    }

    function revertCreateVaultWithPermissionsWithDoubleInitialize(
        PermissionsConfig calldata _permissionsConfig
    ) external returns (IStakingVault vault, Permissions__Harness permissions) {
        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        // create Permissions
        bytes memory immutableArgs = abi.encode(vault);
        permissions = Permissions__Harness(payable(Clones.cloneWithImmutableArgs(PERMISSIONS_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(address(permissions), _permissionsConfig.nodeOperator, PREDEPOSIT_GUARANTEE);

        // initialize Permissions
        permissions.initialize(address(this), _permissionsConfig.confirmExpiry);
        // should revert here
        permissions.initialize(address(this), _permissionsConfig.confirmExpiry);

        // setup roles
        _setupRoles(permissions, _permissionsConfig);

        permissions.revokeRole(permissions.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(permissions), address(vault));
        emit PermissionsCreated(_permissionsConfig.defaultAdmin, address(permissions));
    }

    function revertCreateVaultWithPermissionsWithZeroDefaultAdmin(
        PermissionsConfig calldata _permissionsConfig
    ) external returns (IStakingVault vault, Permissions__Harness permissions) {
        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        // create Permissions
        bytes memory immutableArgs = abi.encode(vault);
        permissions = Permissions__Harness(payable(Clones.cloneWithImmutableArgs(PERMISSIONS_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(address(permissions), _permissionsConfig.nodeOperator, PREDEPOSIT_GUARANTEE);

        // should revert here
        permissions.initialize(address(0), _permissionsConfig.confirmExpiry);

        // setup roles
        _setupRoles(permissions, _permissionsConfig);

        permissions.revokeRole(permissions.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(permissions), address(vault));
        emit PermissionsCreated(_permissionsConfig.defaultAdmin, address(permissions));
    }

    /// @dev Helper function to setup roles for permissions
    function _setupRoles(Permissions__Harness permissions, PermissionsConfig calldata _permissionsConfig) private {
        permissions.grantRole(permissions.DEFAULT_ADMIN_ROLE(), _permissionsConfig.defaultAdmin);
        permissions.grantRole(permissions.FUND_ROLE(), _permissionsConfig.funder);
        permissions.grantRole(permissions.WITHDRAW_ROLE(), _permissionsConfig.withdrawer);
        permissions.grantRole(permissions.MINT_ROLE(), _permissionsConfig.minter);
        permissions.grantRole(permissions.BURN_ROLE(), _permissionsConfig.burner);
        permissions.grantRole(permissions.REBALANCE_ROLE(), _permissionsConfig.rebalancer);
        permissions.grantRole(permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), _permissionsConfig.depositPauser);
        permissions.grantRole(permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), _permissionsConfig.depositResumer);
        permissions.grantRole(permissions.PDG_COMPENSATE_PREDEPOSIT_ROLE(), _permissionsConfig.pdgCompensator);
        permissions.grantRole(permissions.PDG_PROVE_VALIDATOR_ROLE(), _permissionsConfig.unknownValidatorProver);
        permissions.grantRole(
            permissions.UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE(),
            _permissionsConfig.unguaranteedBeaconChainDepositor
        );
        permissions.grantRole(permissions.REQUEST_VALIDATOR_EXIT_ROLE(), _permissionsConfig.validatorExitRequester);
        permissions.grantRole(
            permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
            _permissionsConfig.validatorWithdrawalTriggerer
        );
        permissions.grantRole(permissions.VOLUNTARY_DISCONNECT_ROLE(), _permissionsConfig.disconnecter);
        permissions.grantRole(permissions.CHANGE_TIER_ROLE(), _permissionsConfig.tierChanger);
    }

    event VaultCreated(address indexed owner, address indexed vault);

    event PermissionsCreated(address indexed admin, address indexed permissions);

    error ZeroArgument(string argument);
}
