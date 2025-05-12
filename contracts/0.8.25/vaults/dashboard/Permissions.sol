// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {AccessControlConfirmable} from "contracts/0.8.25/utils/AccessControlConfirmable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/Ownable2StepUpgradeable.sol";

import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "../interfaces/IPredepositGuarantee.sol";
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
     * @notice Permission for transferring the StakingVault ownership when disconnected from the VaultHub.
     */
    bytes32 public constant MANAGE_OWNERSHIP_ROLE = keccak256("vaults.Permissions.ManageOwnership");

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
    IPredepositGuarantee public immutable PREDEPOSIT_GUARANTEE;

    /**
     * @notice Indicates whether the contract has been initialized
     */
    bool public initialized;

    /**
     * @notice Constructor sets the address of the implementation contract.
     */
    constructor(address _vaultHub, address _predepositGuarantee) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");
        if (_predepositGuarantee == address(0)) revert ZeroArgument("_predepositGuarantee");

        _SELF = address(this);
        VAULT_HUB = VaultHub(payable(_vaultHub));
        PREDEPOSIT_GUARANTEE = IPredepositGuarantee(payable(_predepositGuarantee));
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
     * @dev Checks the FUND_ROLE and funds the StakingVault.
     * @param _ether The amount of ether to fund the StakingVault with.
     */
    function _fund(uint256 _ether) internal onlyRole(FUND_ROLE) {
        VAULT_HUB.fund{value: _ether}(address(_stakingVault()));
    }

    /**
     * @dev Checks the WITHDRAW_ROLE and withdraws funds from the StakingVault.
     * @param _recipient The address to withdraw the funds to.
     * @param _ether The amount of ether to withdraw from the StakingVault.
     * @dev The zero checks for recipient and ether are performed in the StakingVault contract.
     */
    function _withdraw(address _recipient, uint256 _ether) internal virtual onlyRole(WITHDRAW_ROLE) {
        VAULT_HUB.withdraw(address(_stakingVault()), _recipient, _ether);
    }

    /**
     * @dev Checks the MINT_ROLE and mints shares backed by the StakingVault.
     * @param _recipient The address to mint the shares to.
     * @param _shares The amount of shares to mint.
     * @dev The zero checks for parameters are performed in the VaultHub contract.
     */
    function _mintShares(address _recipient, uint256 _shares) internal onlyRole(MINT_ROLE) {
        VAULT_HUB.mintShares(address(_stakingVault()), _recipient, _shares);
    }

    /**
     * @dev Checks the BURN_ROLE and burns shares backed by the StakingVault.
     * @param _shares The amount of shares to burn.
     * @dev The zero check for parameters is performed in the VaultHub contract.
     */
    function _burnShares(uint256 _shares) internal onlyRole(BURN_ROLE) {
        VAULT_HUB.burnShares(address(_stakingVault()), _shares);
    }

    /**
     * @dev Checks the REBALANCE_ROLE and rebalances the StakingVault.
     * @param _ether The amount of ether to rebalance the StakingVault with.
     * @dev The zero check for parameters is performed in the StakingVault contract.
     */
    function _rebalanceVault(uint256 _ether) internal onlyRole(REBALANCE_ROLE) {
        VAULT_HUB.rebalance(address(_stakingVault()), _ether);
    }

    /**
     * @dev Checks the PAUSE_BEACON_CHAIN_DEPOSITS_ROLE and pauses beacon chain deposits on the StakingVault.
     */
    function _pauseBeaconChainDeposits() internal onlyRole(PAUSE_BEACON_CHAIN_DEPOSITS_ROLE) {
        VAULT_HUB.pauseBeaconChainDeposits(address(_stakingVault()));
    }

    /**
     * @dev Checks the RESUME_BEACON_CHAIN_DEPOSITS_ROLE and resumes beacon chain deposits on the StakingVault.
     */
    function _resumeBeaconChainDeposits() internal onlyRole(RESUME_BEACON_CHAIN_DEPOSITS_ROLE) {
        VAULT_HUB.resumeBeaconChainDeposits(address(_stakingVault()));
    }

    /**
     * @dev Checks the REQUEST_VALIDATOR_EXIT_ROLE and requests validator exit on the StakingVault.
     * @dev The zero check for _pubkeys is performed in the StakingVault contract.
     */
    function _requestValidatorExit(bytes calldata _pubkeys) internal onlyRole(REQUEST_VALIDATOR_EXIT_ROLE) {
        VAULT_HUB.requestValidatorExit(address(_stakingVault()), _pubkeys);
    }

    /**
     * @dev Checks the TRIGGER_VALIDATOR_WITHDRAWAL_ROLE and triggers validator withdrawal on the StakingVault using EIP-7002 triggerable exit.
     * @dev The zero checks for parameters are performed in the StakingVault contract.
     */
    function _triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) internal onlyRole(TRIGGER_VALIDATOR_WITHDRAWAL_ROLE) {
        VAULT_HUB.triggerValidatorWithdrawal{value: msg.value}(address(_stakingVault()), _pubkeys, _amounts, _refundRecipient);
    }

    /**
     * @dev Checks the VOLUNTARY_DISCONNECT_ROLE and voluntarily disconnects the StakingVault.
     */
    function _voluntaryDisconnect() internal onlyRole(VOLUNTARY_DISCONNECT_ROLE) {
        VAULT_HUB.voluntaryDisconnect(address(_stakingVault()));
    }

    /**
     * @dev Checks the MANAGE_OWNERSHIP_ROLE and transfers the StakingVault ownership.
     * @param _newOwner The address to transfer the ownership to.
     */
    function _transferOwnership(address _newOwner) internal onlyRole(MANAGE_OWNERSHIP_ROLE) {
        OwnableUpgradeable(address(_stakingVault())).transferOwnership(_newOwner);
    }

    /**
     * @dev Checks the MANAGE_OWNERSHIP_ROLE and accepts the StakingVault ownership.
     */
    function _acceptOwnership() internal onlyRole(MANAGE_OWNERSHIP_ROLE) {
        Ownable2StepUpgradeable(address(_stakingVault())).acceptOwnership();
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
    ) internal onlyRole(PDG_COMPENSATE_PREDEPOSIT_ROLE) returns (uint256) {
        return PREDEPOSIT_GUARANTEE.compensateDisprovenPredeposit(_pubkey, _recipient);
    }

    /**
     * @dev Proves validators unknown to PDG that have correct vault WC
     */
    function _proveUnknownValidatorsToPDG(
        IPredepositGuarantee.ValidatorWitness[] calldata _witnesses
    ) internal onlyRole(PDG_PROVE_VALIDATOR_ROLE) {
        for (uint256 i = 0; i < _witnesses.length; i++) {
            PREDEPOSIT_GUARANTEE.proveUnknownValidator(_witnesses[i], _stakingVault());
        }
    }

    /**
     * @dev Withdraws ether from vault to this contract for unguaranteed deposit to validators
     */
    function _withdrawForUnguaranteedDepositToBeaconChain(
        uint256 _ether
    ) internal onlyRole(UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE) {
        VAULT_HUB.withdraw(address(_stakingVault()), address(this), _ether);
    }

    /**
     * @dev Checks the confirming roles and sets the owner on the StakingVault.
     * @param _newOwner The address to set the owner to.
     */
    function _setVaultOwner(address _newOwner) internal onlyConfirmed(confirmingRoles()) {
        VAULT_HUB.setVaultOwner(address(_stakingVault()), _newOwner);
    }

    /**
     * @dev Checks the OSSIFY_ROLE and ossifies the StakingVault.
     */
    function _ossifyStakingVault() internal onlyRole(OSSIFY_ROLE) {
        _stakingVault().ossify();
    }

    /**
     * @dev Checks the REQUEST_TIER_CHANGE_ROLE and requests a change of the tier on the OperatorGrid.
     * @param _tierId The tier to change to.
     */
    function _requestTierChange(uint256 _tierId) internal onlyRole(REQUEST_TIER_CHANGE_ROLE) {
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
