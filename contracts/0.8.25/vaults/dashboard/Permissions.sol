// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {AccessControlConfirmable} from "contracts/0.8.25/utils/AccessControlConfirmable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "../interfaces/IPredepositGuarantee.sol";
import {VaultHub} from "../VaultHub.sol";
import {OperatorGrid} from "../OperatorGrid.sol";

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
    bytes32 public constant FUND_ROLE = keccak256("vaults.Permissions.Fund");

    /**
     * @notice Permission for withdrawing funds from the StakingVault.
     */
    bytes32 public constant WITHDRAW_ROLE = keccak256("vaults.Permissions.Withdraw");

    /**
     * @notice Permission for locking ether on StakingVault.
     */
    bytes32 public constant LOCK_ROLE = keccak256("vaults.Permissions.Lock");

    /**
     * @notice Permission for minting stETH shares backed by the StakingVault.
     */
    bytes32 public constant MINT_ROLE = keccak256("vaults.Permissions.Mint");

    /**
     * @notice Permission for burning stETH shares backed by the StakingVault.
     */
    bytes32 public constant BURN_ROLE = keccak256("vaults.Permissions.Burn");

    /**
     * @notice Permission for rebalancing the StakingVault.
     */
    bytes32 public constant REBALANCE_ROLE = keccak256("vaults.Permissions.Rebalance");

    /**
     * @notice Permission for pausing beacon chain deposits on the StakingVault.
     */
    bytes32 public constant PAUSE_BEACON_CHAIN_DEPOSITS_ROLE = keccak256("vaults.Permissions.PauseDeposits");

    /**
     * @notice Permission for resuming beacon chain deposits on the StakingVault.
     */
    bytes32 public constant RESUME_BEACON_CHAIN_DEPOSITS_ROLE = keccak256("vaults.Permissions.ResumeDeposits");

    /**
     * @notice Permission for requesting validator exit from the StakingVault.
     */
    bytes32 public constant REQUEST_VALIDATOR_EXIT_ROLE = keccak256("vaults.Permissions.RequestValidatorExit");

    /**
     * @notice Permission for triggering validator withdrawal from the StakingVault using EIP-7002 triggerable exit.
     */
    bytes32 public constant TRIGGER_VALIDATOR_WITHDRAWAL_ROLE =
        keccak256("vaults.Permissions.TriggerValidatorWithdrawal");

    /**
     * @notice Permission for voluntary disconnecting the StakingVault.
     */
    bytes32 public constant VOLUNTARY_DISCONNECT_ROLE = keccak256("vaults.Permissions.VoluntaryDisconnect");

    /**
     * @notice Permission for getting compensation for disproven validator predeposit from PDG
     */
    bytes32 public constant PDG_COMPENSATE_PREDEPOSIT_ROLE = keccak256("vaults.Permissions.PDGCompensatePredeposit");

    /**
     * @notice Permission for proving valid vault validators unknown to the PDG
     */
    bytes32 public constant PDG_PROVE_VALIDATOR_ROLE = keccak256("vaults.Permissions.PDGProveValidator");

    /**
     * @notice Permission for unguarnateed deposit to trusted validators
     */
    bytes32 public constant UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE =
        keccak256("vaults.Permissions.UnguaranteedBeaconChainDeposit");

    /**
     * @dev Permission for deauthorizing Lido VaultHub from the StakingVault.
     */
    bytes32 public constant LIDO_VAULTHUB_DEAUTHORIZATION_ROLE =
        keccak256("vaults.Permissions.LidoVaultHubDeauthorization");

    /**
     * @dev Permission for granting authorization to Lido VaultHub on the StakingVault.
     */
    bytes32 public constant LIDO_VAULTHUB_AUTHORIZATION_ROLE =
        keccak256("vaults.Permissions.LidoVaultHubAuthorization");

    /**
     * @dev Permission for ossifying the StakingVault.
     */
    bytes32 public constant OSSIFY_ROLE = keccak256("vaults.Permissions.Ossify");

    /**
     * @dev Permission for setting depositor on the StakingVault.
     */
    bytes32 public constant SET_DEPOSITOR_ROLE = keccak256("vaults.Permissions.SetDepositor");

    /**
     * @dev Permission for resetting locked amount on the disconnected StakingVault.
     */
    bytes32 public constant RESET_LOCKED_ROLE = keccak256("vaults.Permissions.ResetLocked");

    /**
     * @dev Permission for requesting change of tier on the OperatorGrid.
     */
    bytes32 public constant REQUEST_TIER_CHANGE_ROLE = keccak256("vaults.Permissions.RequestTierChange");

    /**
     * @notice Address of the implementation contract
     * @dev Used to prevent initialization in the implementation
     */
    address private immutable _SELF;

    VaultHub public immutable VAULT_HUB;

    /**
     * @notice Indicates whether the contract has been initialized
     */
    bool public initialized;

    /**
     * @notice Constructor sets the address of the implementation contract.
     */
    constructor(address _vaultHub) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");

        _SELF = address(this);
        VAULT_HUB = VaultHub(_vaultHub);
    }

    /**
     * @notice Modifier to prevent reinitialization of the contract.
     * @dev Extracted to modifier to avoid Slither warning.
     */
    modifier initializer() {
        if (initialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();

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
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");

        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
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
        if (_assignments.length == 0) revert ZeroArgument("_assignments");

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
        if (_assignments.length == 0) revert ZeroArgument("_assignments");

        for (uint256 i = 0; i < _assignments.length; i++) {
            revokeRole(_assignments[i].role, _assignments[i].account);
        }
    }

    /**
     * @dev Returns an array of roles that need to confirm the call
     *      used for the `onlyConfirmed` modifier.
     *      At this level, only the DEFAULT_ADMIN_ROLE is needed to confirm the call
     *      but in inherited contracts, the function can be overridden to add more roles,
     *      which are introduced further in the inheritance chain.
     * @return The roles that need to confirm the call.
     */
    function confirmingRoles() public pure virtual returns (bytes32[] memory);

    /**
     * @dev A custom modifier that checks if the caller has a role or the admin role for a given role.
     * @param _role The role to check.
     */
    modifier onlyRoleMemberOrAdmin(bytes32 _role) {
        if (hasRole(_role, msg.sender) || hasRole(getRoleAdmin(_role), msg.sender)) {
            _;
        } else {
            revert AccessControlUnauthorizedAccount(msg.sender, _role);
        }
    }

    /**
     * @dev Checks the FUND_ROLE and funds the StakingVault.
     * @param _ether The amount of ether to fund the StakingVault with.
     */
    function _fund(uint256 _ether) internal onlyRoleMemberOrAdmin(FUND_ROLE) {
        _stakingVault().fund{value: _ether}();
    }

    /**
     * @dev Checks the WITHDRAW_ROLE and withdraws funds from the StakingVault.
     * @param _recipient The address to withdraw the funds to.
     * @param _ether The amount of ether to withdraw from the StakingVault.
     * @dev The zero checks for recipient and ether are performed in the StakingVault contract.
     */
    function _withdraw(address _recipient, uint256 _ether) internal virtual onlyRoleMemberOrAdmin(WITHDRAW_ROLE) {
        _stakingVault().withdraw(_recipient, _ether);
    }

    /**
     * @dev Checks the LOCK_ROLE and increases the locked amount on the StakingVault.
     * @param _locked The amount of locked ether, must be greater or equal to the current locked amount.
     */
    function _lock(uint256 _locked) internal onlyRoleMemberOrAdmin(LOCK_ROLE) {
        _stakingVault().lock(_locked);
    }

    /**
     * @dev Checks the MINT_ROLE and mints shares backed by the StakingVault.
     * @param _recipient The address to mint the shares to.
     * @param _shares The amount of shares to mint.
     * @dev The zero checks for parameters are performed in the VaultHub contract.
     */
    function _mintShares(address _recipient, uint256 _shares) internal onlyRoleMemberOrAdmin(MINT_ROLE) {
        VAULT_HUB.mintShares(address(_stakingVault()), _recipient, _shares);
    }

    /**
     * @dev Checks the BURN_ROLE and burns shares backed by the StakingVault.
     * @param _shares The amount of shares to burn.
     * @dev The zero check for parameters is performed in the VaultHub contract.
     */
    function _burnShares(uint256 _shares) internal onlyRoleMemberOrAdmin(BURN_ROLE) {
        VAULT_HUB.burnShares(address(_stakingVault()), _shares);
    }

    /**
     * @dev Checks the REBALANCE_ROLE and rebalances the StakingVault.
     * @param _ether The amount of ether to rebalance the StakingVault with.
     * @dev The zero check for parameters is performed in the StakingVault contract.
     */
    function _rebalanceVault(uint256 _ether) internal onlyRoleMemberOrAdmin(REBALANCE_ROLE) {
        _stakingVault().rebalance(_ether);
    }

    /**
     * @dev Checks the PAUSE_BEACON_CHAIN_DEPOSITS_ROLE and pauses beacon chain deposits on the StakingVault.
     */
    function _pauseBeaconChainDeposits() internal onlyRoleMemberOrAdmin(PAUSE_BEACON_CHAIN_DEPOSITS_ROLE) {
        _stakingVault().pauseBeaconChainDeposits();
    }

    /**
     * @dev Checks the RESUME_BEACON_CHAIN_DEPOSITS_ROLE and resumes beacon chain deposits on the StakingVault.
     */
    function _resumeBeaconChainDeposits() internal onlyRoleMemberOrAdmin(RESUME_BEACON_CHAIN_DEPOSITS_ROLE) {
        _stakingVault().resumeBeaconChainDeposits();
    }

    /**
     * @dev Checks the REQUEST_VALIDATOR_EXIT_ROLE and requests validator exit on the StakingVault.
     * @dev The zero check for _pubkeys is performed in the StakingVault contract.
     */
    function _requestValidatorExit(bytes calldata _pubkeys) internal onlyRoleMemberOrAdmin(REQUEST_VALIDATOR_EXIT_ROLE) {
        _stakingVault().requestValidatorExit(_pubkeys);
    }

    /**
     * @dev Checks the TRIGGER_VALIDATOR_WITHDRAWAL_ROLE and triggers validator withdrawal on the StakingVault using EIP-7002 triggerable exit.
     * @dev The zero checks for parameters are performed in the StakingVault contract.
     */
    function _triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) internal onlyRoleMemberOrAdmin(TRIGGER_VALIDATOR_WITHDRAWAL_ROLE) {
        _stakingVault().triggerValidatorWithdrawal{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    /**
     * @dev Checks the VOLUNTARY_DISCONNECT_ROLE and voluntarily disconnects the StakingVault.
     */
    function _voluntaryDisconnect() internal onlyRoleMemberOrAdmin(VOLUNTARY_DISCONNECT_ROLE) {
        VAULT_HUB.voluntaryDisconnect(address(_stakingVault()));
    }

    /**
     * @dev Checks the PDG_COMPENSATE_PREDEPOSIT_ROLE and claims disproven predeposit from PDG.
     * @param _pubkey The pubkey of the validator.
     * @param _recipient The address to compensate the disproven validator predeposit to.
     * @return The amount of ether compensated.
     */
    function _compensateDisprovenPredepositFromPDG(
        bytes calldata _pubkey,
        address _recipient
    ) internal onlyRoleMemberOrAdmin(PDG_COMPENSATE_PREDEPOSIT_ROLE) returns (uint256) {
        return IPredepositGuarantee(_stakingVault().depositor()).compensateDisprovenPredeposit(_pubkey, _recipient);
    }

    /**
     * @dev Proves validators unknown to PDG that have correct vault WC
     */
    function _proveUnknownValidatorsToPDG(
        IPredepositGuarantee.ValidatorWitness[] calldata _witnesses
    ) internal onlyRoleMemberOrAdmin(PDG_PROVE_VALIDATOR_ROLE) {
        IStakingVault vault = _stakingVault();
        IPredepositGuarantee pdg = IPredepositGuarantee(vault.depositor());
        for (uint256 i = 0; i < _witnesses.length; i++) {
            pdg.proveUnknownValidator(_witnesses[i], vault);
        }
    }

    /**
     * @dev Withdraws ether from vault to this contract for unguaranteed deposit to validators
     */
    function _withdrawForUnguaranteedDepositToBeaconChain(
        uint256 _ether
    ) internal onlyRoleMemberOrAdmin(UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE) {
        _stakingVault().withdraw(address(this), _ether);
    }

    /**
     * @dev Checks the confirming roles and transfers the StakingVault ownership.
     * @param _newOwner The address to transfer the StakingVault ownership to.
     */
    function _transferStakingVaultOwnership(address _newOwner) internal onlyConfirmed(confirmingRoles()) {
        OwnableUpgradeable(address(_stakingVault())).transferOwnership(_newOwner);
    }

    /**
     * @dev Checks the LIDO_VAULTHUB_AUTHORIZATION_ROLE and authorizes Lido VaultHub on the StakingVault.
     */
    function _authorizeLidoVaultHub() internal onlyRoleMemberOrAdmin(LIDO_VAULTHUB_AUTHORIZATION_ROLE) {
        _stakingVault().authorizeLidoVaultHub();
    }

    /**
     * @dev Checks the LIDO_VAULTHUB_DEAUTHORIZATION_ROLE and deauthorizes Lido VaultHub from the StakingVault.
     */
    function _deauthorizeLidoVaultHub() internal onlyRoleMemberOrAdmin(LIDO_VAULTHUB_DEAUTHORIZATION_ROLE) {
        _stakingVault().deauthorizeLidoVaultHub();
    }

    /**
     * @dev Checks the OSSIFY_ROLE and ossifies the StakingVault.
     */
    function _ossifyStakingVault() internal onlyRoleMemberOrAdmin(OSSIFY_ROLE) {
        _stakingVault().ossifyStakingVault();
    }

    /**
     * @dev Checks the SET_DEPOSITOR_ROLE and sets the depositor on the StakingVault.
     * @param _depositor The address to set the depositor to.
     */
    function _setDepositor(address _depositor) internal onlyRoleMemberOrAdmin(SET_DEPOSITOR_ROLE) {
        _stakingVault().setDepositor(_depositor);
    }

    /**
     * @dev Checks the RESET_LOCKED_ROLE and resets the locked amount on the disconnected StakingVault.
     */
    function _resetLocked() internal onlyRoleMemberOrAdmin(RESET_LOCKED_ROLE) {
        _stakingVault().resetLocked();
    }

    /**
     * @dev Checks the REQUEST_TIER_CHANGE_ROLE and requests a change of the tier on the OperatorGrid.
     * @param _tierId The tier to change to.
     */
    function _requestTierChange(uint256 _tierId) internal onlyRoleMemberOrAdmin(REQUEST_TIER_CHANGE_ROLE) {
        OperatorGrid(VAULT_HUB.operatorGrid()).requestTierChange(address(_stakingVault()), _tierId);
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

    /**
     * @notice Emitted when the contract is initialized
     */
    event Initialized();

    /**
     * @notice Error when direct calls to the implementation are forbidden
     */
    error NonProxyCallsForbidden();

    /**
     * @notice Error when the contract is already initialized.
     */
    error AlreadyInitialized();

    /**
     * @notice Error thrown for when a given value cannot be zero
     * @param argument Name of the argument
     */
    error ZeroArgument(string argument);
}
