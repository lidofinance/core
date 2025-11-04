// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {AccessControlConfirmable} from "contracts/0.8.25/utils/AccessControlConfirmable.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {OperatorGrid} from "../OperatorGrid.sol";
import {VaultHub} from "../VaultHub.sol";

/**
 * @title Permissions
 * @author Lido
 * @notice Provides granular permissions for StakingVault operations.
 */
abstract contract Permissions is AccessControlConfirmable {
    /**
     * @notice Struct containing an account and a role for granting/revoking roles.
     */
    struct RoleAssignment {
        address account;
        bytes32 role;
    }

    /**
     * @notice Permission for funding the StakingVault.
     */
    /// @dev 0x933b7d5c112a4d05b489cea0b2ced98acb27d3d0fc9827c92cdacb2d6c5559c2
    bytes32 public constant FUND_ROLE = keccak256("vaults.Permissions.Fund");

    /**
     * @notice Permission for withdrawing funds from the StakingVault.
     */
    /// @dev 0x355caf1c2580ed8185acb5ea3573b71f85186b41bdf69e3eb8f1fcd122a562df
    bytes32 public constant WITHDRAW_ROLE = keccak256("vaults.Permissions.Withdraw");

    /**
     * @notice Permission for minting stETH shares backed by the StakingVault.
     */
    /// @dev 0xe996ac9b332538bb1fa3cd6743aa47011623cdb94bd964a494ee9d371e4a27d3
    bytes32 public constant MINT_ROLE = keccak256("vaults.Permissions.Mint");

    /**
     * @notice Permission for burning stETH shares backed by the StakingVault.
     */
    /// @dev 0x689f0a569be0c9b6cd2c11c81cb0add722272abdae6b649fdb1e05f1d9bb8a2f
    bytes32 public constant BURN_ROLE = keccak256("vaults.Permissions.Burn");

    /**
     * @notice Permission for rebalancing the StakingVault.
     */
    /// @dev 0x3f82ecf462ddac43fc17ba11472c35f18b7760b4f5a5fc50b9625f9b5a22cf62
    bytes32 public constant REBALANCE_ROLE = keccak256("vaults.Permissions.Rebalance");

    /**
     * @notice Permission for pausing beacon chain deposits on the StakingVault.
     */
    /// @dev 0xa90c7030a27f389f9fc8ed21a0556f40c88130cc14a80db936bed68261819b2c
    bytes32 public constant PAUSE_BEACON_CHAIN_DEPOSITS_ROLE = keccak256("vaults.Permissions.PauseDeposits");

    /**
     * @notice Permission for resuming beacon chain deposits on the StakingVault.
     */
    /// @dev 0x59d005e32db662b94335d6bedfeb453fd2202b9f0cc7a6ed498d9098171744b0
    bytes32 public constant RESUME_BEACON_CHAIN_DEPOSITS_ROLE = keccak256("vaults.Permissions.ResumeDeposits");

    /**
     * @notice Permission for requesting validator exit from the StakingVault.
     */
    /// @dev 0x32d0d6546e21c13ff633616141dc9daad87d248d1d37c56bf493d06d627ecb7b
    bytes32 public constant REQUEST_VALIDATOR_EXIT_ROLE = keccak256("vaults.Permissions.RequestValidatorExit");

    /**
     * @notice Permission for triggering validator withdrawal from the StakingVault using EIP-7002 triggerable exit.
     */
    /// @dev 0xea19d3b23bd90fdd52445ad672f2b6fb1fef7230d49c6a827c1cd288d02994d5
    bytes32 public constant TRIGGER_VALIDATOR_WITHDRAWAL_ROLE =
        keccak256("vaults.Permissions.TriggerValidatorWithdrawal");

    /**
     * @notice Permission for voluntary disconnecting the StakingVault.
     */
    /// @dev 0x9586321ac05f110e4b4a0a42aba899709345af0ca78910e8832ddfd71fed2bf4
    bytes32 public constant VOLUNTARY_DISCONNECT_ROLE = keccak256("vaults.Permissions.VoluntaryDisconnect");

    /**
     * @dev Permission for vault configuration operations on the OperatorGrid (tier changes, tier sync, share limit updates).
     */
    /// @dev 0x25482e7dc9e29f6da5bd70b6d19d17bbf44021da51ba0664a9f430c94a09c674
    bytes32 public constant VAULT_CONFIGURATION_ROLE = keccak256("vaults.Permissions.VaultConfiguration");

    VaultHub public immutable VAULT_HUB;
    ILidoLocator public immutable LIDO_LOCATOR;

    /**
     * @notice Indicates whether the contract has been initialized
     */
    bool public initialized;

    constructor(address _vaultHub, address _lidoLocator) {
        _requireNotZero(_vaultHub);
        _requireNotZero(_lidoLocator);

        initialized = true;

        // @dev vaultHub is cached as immutable to save gas for main operations
        VAULT_HUB = VaultHub(payable(_vaultHub));
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);
    }

    /**
     * @notice Modifier to prevent reinitialization of the contract.
     * @dev Extracted to modifier to avoid Slither warning.
     */
    modifier initializer() {
        if (initialized) revert AlreadyInitialized();

        initialized = true;
        _;

        emit Initialized();
    }

    /**
     * @dev Sets the ACL default admin and confirmation expiry time.
     * @param _defaultAdmin The address of the default admin
     * @param _confirmExpiry The confirmation expiry time in seconds
     */
    function _initialize(address _defaultAdmin, uint256 _confirmExpiry) internal initializer {
        _requireNotZero(_defaultAdmin);

        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
        _validateConfirmExpiry(_confirmExpiry);
        _setConfirmExpiry(_confirmExpiry);
    }

    /**
     * @notice Returns the address of the underlying StakingVault.
     * @return The address of the StakingVault.
     */
    function stakingVault() external view returns (IStakingVault) {
        return _stakingVault();
    }

    // ==================== Role Management Functions ====================

    /**
     * @notice Mass-grants multiple roles to multiple accounts.
     * @param _assignments An array of role assignments.
     * @dev Performs the role admin checks internally.
     * @dev If an account is already a member of a role, doesn't revert, emits no events.
     */
    function grantRoles(RoleAssignment[] calldata _assignments) external {
        _requireNotZero(_assignments.length);

        for (uint256 i = 0; i < _assignments.length; i++) {
            grantRole(_assignments[i].role, _assignments[i].account);
        }
    }

    /**
     * @notice Mass-revokes multiple roles from multiple accounts.
     * @param _assignments An array of role assignments.
     * @dev Performs the role admin checks internally.
     * @dev If an account is not a member of a role, doesn't revert, emits no events.
     */
    function revokeRoles(RoleAssignment[] calldata _assignments) external {
        _requireNotZero(_assignments.length);

        for (uint256 i = 0; i < _assignments.length; i++) {
            revokeRole(_assignments[i].role, _assignments[i].account);
        }
    }

    /**
     * @dev A custom modifier that checks if the caller has a role or the admin role for a given role.
     * @param _role The role to check.
     */
    modifier onlyRoleMemberOrAdmin(bytes32 _role) {
        if (!(hasRole(_role, msg.sender) || hasRole(getRoleAdmin(_role), msg.sender))) {
            revert AccessControlUnauthorizedAccount(msg.sender, _role);
        }
        _;
    }

    /**
     * @dev Checks the FUND_ROLE and funds the StakingVault.
     * @param _ether The amount of ether to fund the StakingVault with.
     */
    function _fund(uint256 _ether) internal onlyRoleMemberOrAdmin(FUND_ROLE) {
        VAULT_HUB.fund{value: _ether}(address(_stakingVault()));
    }

    /**
     * @dev Checks the WITHDRAW_ROLE and withdraws funds from the StakingVault.
     * @param _recipient The address to withdraw the funds to.
     * @param _ether The amount of ether to withdraw from the StakingVault.
     */
    function _withdraw(address _recipient, uint256 _ether) internal virtual onlyRoleMemberOrAdmin(WITHDRAW_ROLE) {
        _doWithdraw(_recipient, _ether);
    }

    /**
     * @dev Checks the MINT_ROLE and mints shares backed by the StakingVault.
     * @param _recipient The address to mint the shares to.
     * @param _shares The amount of shares to mint.
     */
    function _mintShares(address _recipient, uint256 _shares) internal onlyRoleMemberOrAdmin(MINT_ROLE) {
        VAULT_HUB.mintShares(address(_stakingVault()), _recipient, _shares);
    }

    /**
     * @dev Checks the BURN_ROLE and burns shares backed by the StakingVault.
     * @param _shares The amount of shares to burn.
     */
    function _burnShares(uint256 _shares) internal onlyRoleMemberOrAdmin(BURN_ROLE) {
        VAULT_HUB.burnShares(address(_stakingVault()), _shares);
    }

    /**
     * @dev Checks the REBALANCE_ROLE and rebalances the StakingVault.
     * @param _shares The amount of shares to rebalance the StakingVault with.
     */
    function _rebalanceVault(uint256 _shares) internal onlyRoleMemberOrAdmin(REBALANCE_ROLE) {
        VAULT_HUB.rebalance(address(_stakingVault()), _shares);
    }

    /**
     * @dev Checks the PAUSE_BEACON_CHAIN_DEPOSITS_ROLE and pauses beacon chain deposits on the StakingVault.
     */
    function _pauseBeaconChainDeposits() internal onlyRoleMemberOrAdmin(PAUSE_BEACON_CHAIN_DEPOSITS_ROLE) {
        VAULT_HUB.pauseBeaconChainDeposits(address(_stakingVault()));
    }

    /**
     * @dev Checks the RESUME_BEACON_CHAIN_DEPOSITS_ROLE and resumes beacon chain deposits on the StakingVault.
     */
    function _resumeBeaconChainDeposits() internal onlyRoleMemberOrAdmin(RESUME_BEACON_CHAIN_DEPOSITS_ROLE) {
        VAULT_HUB.resumeBeaconChainDeposits(address(_stakingVault()));
    }

    /**
     * @dev Checks the REQUEST_VALIDATOR_EXIT_ROLE and requests validator exit on the StakingVault.
     */
    function _requestValidatorExit(
        bytes calldata _pubkeys
    ) internal onlyRoleMemberOrAdmin(REQUEST_VALIDATOR_EXIT_ROLE) {
        VAULT_HUB.requestValidatorExit(address(_stakingVault()), _pubkeys);
    }

    /**
     * @dev Checks the TRIGGER_VALIDATOR_WITHDRAWAL_ROLE and triggers validator withdrawal on the StakingVault
     *      using EIP-7002 triggerable exit.
     */
    function _triggerValidatorWithdrawals(
        bytes calldata _pubkeys,
        uint64[] calldata _amountsInGwei,
        address _refundRecipient
    ) internal onlyRoleMemberOrAdmin(TRIGGER_VALIDATOR_WITHDRAWAL_ROLE) {
        VAULT_HUB.triggerValidatorWithdrawals{value: msg.value}(
            address(_stakingVault()),
            _pubkeys,
            _amountsInGwei,
            _refundRecipient
        );
    }

    /**
     * @dev Checks the VOLUNTARY_DISCONNECT_ROLE and voluntarily disconnects the StakingVault.
     */
    function _voluntaryDisconnect() internal onlyRoleMemberOrAdmin(VOLUNTARY_DISCONNECT_ROLE) {
        VAULT_HUB.voluntaryDisconnect(address(_stakingVault()));
    }

    /**
     * @dev Checks the DEFAULT_ADMIN_ROLE and transfers the StakingVault ownership.
     * @param _newOwner The address to transfer the ownership to.
     */
    function _transferOwnership(address _newOwner) internal onlyRole(DEFAULT_ADMIN_ROLE) {
        _stakingVault().transferOwnership(_newOwner);
    }

    /**
     * @dev Checks the DEFAULT_ADMIN_ROLE and accepts the StakingVault ownership.
     */
    function _acceptOwnership() internal onlyRole(DEFAULT_ADMIN_ROLE) {
        _stakingVault().acceptOwnership();
    }

    /**
     * @dev Checks the VAULT_CONFIGURATION_ROLE and requests a change of the tier on the OperatorGrid.
     * @param _tierId The tier to change to.
     * @param _requestedShareLimit The requested share limit.
     * @return bool Whether the tier change was executed.
     */
    function _changeTier(
        uint256 _tierId,
        uint256 _requestedShareLimit
    ) internal onlyRoleMemberOrAdmin(VAULT_CONFIGURATION_ROLE) returns (bool) {
        return _operatorGrid().changeTier(address(_stakingVault()), _tierId, _requestedShareLimit);
    }

    /**
     * @dev Checks the VAULT_CONFIGURATION_ROLE and requests a sync of the tier on the OperatorGrid.
     * @return bool Whether the tier sync was executed.
     */
    function _syncTier() internal onlyRoleMemberOrAdmin(VAULT_CONFIGURATION_ROLE) returns (bool) {
        return _operatorGrid().syncTier(address(_stakingVault()));
    }

    /**
     * @dev Checks the VAULT_CONFIGURATION_ROLE and updates the share limit on the OperatorGrid.
     * @param _requestedShareLimit The requested share limit.
     * @return bool Whether the share limit update was executed.
     */
    function _updateVaultShareLimit(uint256 _requestedShareLimit) internal onlyRoleMemberOrAdmin(VAULT_CONFIGURATION_ROLE) returns (bool) {
        return _operatorGrid().updateVaultShareLimit(address(_stakingVault()), _requestedShareLimit);
    }

    /**
     * @dev Loads the address of the underlying StakingVault.
     * @return addr The address of the StakingVault.
     */
    function _stakingVault() internal view returns (IStakingVault) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        address stakingVaultAddress;
        assembly {
            stakingVaultAddress := mload(add(args, 32))
        }
        return IStakingVault(stakingVaultAddress);
    }

    /// @dev internal withdraw function just to save the bytecode for external call method
    function _doWithdraw(address _recipient, uint256 _ether) internal {
        VAULT_HUB.withdraw(address(_stakingVault()), _recipient, _ether);
    }

    function _operatorGrid() internal view returns (OperatorGrid) {
        return OperatorGrid(LIDO_LOCATOR.operatorGrid());
    }

    function _requireNotZero(uint256 _value) internal pure {
        if (_value == 0) revert ZeroArgument();
    }

    function _requireNotZero(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Emitted when the contract is initialized
     */
    event Initialized();

    /**
     * @notice Error when the contract is already initialized.
     */
    error AlreadyInitialized();

    /**
     * @notice Error thrown for when a given value cannot be zero
     */
    error ZeroArgument();

    /**
     * @notice Error thrown for when a given address cannot be zero
     */
    error ZeroAddress();
}
