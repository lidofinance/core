// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {AccessControlConfirmable} from "contracts/0.8.25/utils/AccessControlConfirmable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {PredepositGuarantee} from "../predeposit_guarantee/PredepositGuarantee.sol";
import {VaultHub} from "../VaultHub.sol";

/**
 * @title Permissions
 * @author Lido
 * @notice Granular role-based access control layer for StakingVault operations
 */
abstract contract Permissions is AccessControlConfirmable {
    /**
     * @notice An account-role pair for batch role management
     */
    struct RoleAssignment {
        address account;
        bytes32 role;
    }

    /**
     * @notice Role for funding the StakingVault
     */
    bytes32 public constant FUND_ROLE = keccak256("vaults.Permissions.Fund");

    /**
     * @notice Role for withdrawing ether from the StakingVault
     */
    bytes32 public constant WITHDRAW_ROLE = keccak256("vaults.Permissions.Withdraw");

    /**
     * @notice Role for minting stETH backed by the StakingVault
     */
    bytes32 public constant MINT_ROLE = keccak256("vaults.Permissions.Mint");

    /**
     * @notice Role for burning stETH backed by the StakingVault
     */
    bytes32 public constant BURN_ROLE = keccak256("vaults.Permissions.Burn");

    /**
     * @notice Role for rebalancing the StakingVault
     */
    bytes32 public constant REBALANCE_ROLE = keccak256("vaults.Permissions.Rebalance");

    /**
     * @notice Role for pausing beacon chain deposits
     */
    bytes32 public constant PAUSE_BEACON_CHAIN_DEPOSITS_ROLE = keccak256("vaults.Permissions.PauseDeposits");

    /**
     * @notice Role for resuming beacon chain deposits
     */
    bytes32 public constant RESUME_BEACON_CHAIN_DEPOSITS_ROLE = keccak256("vaults.Permissions.ResumeDeposits");

    /**
     * @notice Role for requesting validator exit from the beacon chain
     */
    bytes32 public constant REQUEST_VALIDATOR_EXIT_ROLE = keccak256("vaults.Permissions.RequestValidatorExit");

    /**
     * @notice Role for triggering validator withdrawal using EIP-7002
     */
    bytes32 public constant TRIGGER_VALIDATOR_WITHDRAWAL_ROLE = keccak256("vaults.Permissions.TriggerValWithdrawal");

    /**
     * @notice Role for voluntary disconnecting the StakingVault from the VaultHub
     */
    bytes32 public constant VOLUNTARY_DISCONNECT_ROLE = keccak256("vaults.Permissions.VoluntaryDisconnect");

    /**
     * @notice Role for withdrawing disproven validator predeposit from PDG
     */
    bytes32 public constant PDG_WITHDRAWAL_ROLE = keccak256("vaults.Permissions.PDGWithdrawal");

    /**
     * @notice Role for emergency asset recovery operations
     */
    bytes32 public constant ASSET_RECOVERY_ROLE = keccak256("vaults.Permissions.AssetRecovery");

    /**
     * @notice Returns the address of the underlying StakingVault
     */
    function stakingVault() public view virtual returns (IStakingVault);

    /**
     * @notice Returns the address of the VaultHub
     */
    function vaultHub() public view virtual returns (VaultHub);

    // ==================== Role Management Functions ====================

    /**
     * @notice Batch grants multiple roles to multiple accounts in a single transaction
     * @param _assignments Array of role-account pairs to grant
     * @dev Gas-efficient way to grant roles to multiple accounts;
     *      each assignment is checked against role admin requirements;
     *      silently skips accounts that already have the specified role
     */
    function grantRoles(RoleAssignment[] memory _assignments) public {
        if (_assignments.length == 0) revert ZeroArgument("_assignments");

        for (uint256 i = 0; i < _assignments.length; i++) {
            grantRole(_assignments[i].role, _assignments[i].account);
        }
    }

    /**
     * @notice Batch revokes multiple roles from multiple accounts in a single transaction
     * @param _assignments Array of role-account pairs to revoke
     * @dev Gas-efficient way to remove roles from multiple accounts;
     *      each revocation is checked against role admin requirements;
     *      silently skips accounts that don't have the specified role
     */
    function revokeRoles(RoleAssignment[] memory _assignments) external {
        if (_assignments.length == 0) revert ZeroArgument("_assignments");

        for (uint256 i = 0; i < _assignments.length; i++) {
            revokeRole(_assignments[i].role, _assignments[i].account);
        }
    }

    /**
     * @notice Returns roles that must confirm sensitive operations
     * @return Array of role identifiers required for confirmation
     */
    function confirmingRoles() public pure virtual returns (bytes32[] memory);

    /**
     * @notice Funds the StakingVault with ETH
     * @param _ether Amount of ETH in wei to send to the vault
     */
    function _fund(uint256 _ether) internal onlyRole(FUND_ROLE) {
        stakingVault().fund{value: _ether}();
    }

    /**
     * @notice Withdraws ETH from the StakingVault to a specified recipient
     * @param _recipient Address to receive the withdrawn ETH
     * @param _ether Amount of ETH in wei to withdraw
     */
    function _withdraw(address _recipient, uint256 _ether) internal virtual onlyRole(WITHDRAW_ROLE) {
        stakingVault().withdraw(_recipient, _ether);
    }

    /**
     * @notice Mints stETH shares backed by the underlying StakingVault
     * @param _recipient Address to receive the newly minted shares
     * @param _shares Amount of shares to mint
     */
    function _mintShares(address _recipient, uint256 _shares) internal onlyRole(MINT_ROLE) {
        vaultHub().mintShares(address(stakingVault()), _recipient, _shares);
    }

    /**
     * @notice Burns stETH shares backed by the underlying StakingVault
     * @param _shares Amount of shares to burn
     */
    function _burnShares(uint256 _shares) internal onlyRole(BURN_ROLE) {
        vaultHub().burnShares(address(stakingVault()), _shares);
    }

    /**
     * @notice Rebalances the underlying StakingVault
     * @param _ether Amount of ETH in wei to use for rebalancing
     */
    function _rebalanceVault(uint256 _ether) internal onlyRole(REBALANCE_ROLE) {
        stakingVault().rebalance(_ether);
    }

    /**
     * @notice Pauses new validator deposits to the beacon chain
     */
    function _pauseBeaconChainDeposits() internal onlyRole(PAUSE_BEACON_CHAIN_DEPOSITS_ROLE) {
        stakingVault().pauseBeaconChainDeposits();
    }

    /**
     * @notice Resumes validator deposits to the beacon chain
     */
    function _resumeBeaconChainDeposits() internal onlyRole(RESUME_BEACON_CHAIN_DEPOSITS_ROLE) {
        stakingVault().resumeBeaconChainDeposits();
    }

    /**
     * @notice Submits exit requests for specific validators by public key
     * @param _pubkeys Concatenated validator public keys (each 48 bytes)
     */
    function _requestValidatorExit(bytes calldata _pubkeys) internal onlyRole(REQUEST_VALIDATOR_EXIT_ROLE) {
        stakingVault().requestValidatorExit(_pubkeys);
    }

    /**
     * @notice Triggers validator withdrawal using EIP-7002 mechanism
     * @param _pubkeys Concatenated validator public keys (each 48 bytes)
     * @param _amounts Array of ETH amounts to trigger withdrawal for
     * @param _refundRecipient Address to receive any refund
     */
    function _triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) internal onlyRole(TRIGGER_VALIDATOR_WITHDRAWAL_ROLE) {
        stakingVault().triggerValidatorWithdrawal{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    /**
     * @notice Voluntarily disconnects the StakingVault from the VaultHub
     */
    function _voluntaryDisconnect() internal onlyRole(VOLUNTARY_DISCONNECT_ROLE) {
        vaultHub().voluntaryDisconnect(address(stakingVault()));
    }

    /**
     * @notice Recovers ETH from disproven validator predeposits
     * @param _pubkey Public key of the validator with disproven predeposit
     * @param _recipient Address to receive the recovered ETH
     * @return Amount of ETH recovered
     */
    function _compensateDisprovenPredepositFromPDG(
        bytes calldata _pubkey,
        address _recipient
    ) internal onlyRole(PDG_WITHDRAWAL_ROLE) returns (uint256) {
        return PredepositGuarantee(stakingVault().depositor()).compensateDisprovenPredeposit(_pubkey, _recipient);
    }

    /**
     * @notice Transfers ownership of the StakingVault to a new owner
     * @param _newOwner Address of the new owner
     */
    function _transferStakingVaultOwnership(address _newOwner) internal onlyConfirmed(confirmingRoles()) {
        OwnableUpgradeable(address(stakingVault())).transferOwnership(_newOwner);
    }

    /**
     * @notice Error thrown when a required parameter is zero or empty
     * @param argument Name of the parameter that cannot be zero/empty
     */
    error ZeroArgument(string argument);
}