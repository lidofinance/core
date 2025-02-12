// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {AccessControlVoteable} from "contracts/0.8.25/utils/AccessControlVoteable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {VaultHub} from "./VaultHub.sol";

/**
 * @title Permissions
 * @author Lido
 * @notice Provides granular permissions for StakingVault operations.
 */
abstract contract Permissions is AccessControlVoteable {
    /**
     * @notice Permission for funding the StakingVault.
     */
    bytes32 public constant FUND_ROLE = keccak256("StakingVault.Permissions.Fund");

    /**
     * @notice Permission for withdrawing funds from the StakingVault.
     */
    bytes32 public constant WITHDRAW_ROLE = keccak256("StakingVault.Permissions.Withdraw");

    /**
     * @notice Permission for minting stETH shares backed by the StakingVault.
     */
    bytes32 public constant MINT_ROLE = keccak256("StakingVault.Permissions.Mint");

    /**
     * @notice Permission for burning stETH shares backed by the StakingVault.
     */
    bytes32 public constant BURN_ROLE = keccak256("StakingVault.Permissions.Burn");

    /**
     * @notice Permission for rebalancing the StakingVault.
     */
    bytes32 public constant REBALANCE_ROLE = keccak256("StakingVault.Permissions.Rebalance");

    /**
     * @notice Permission for pausing beacon chain deposits on the StakingVault.
     */
    bytes32 public constant PAUSE_BEACON_CHAIN_DEPOSITS_ROLE =
        keccak256("StakingVault.Permissions.PauseBeaconChainDeposits");

    /**
     * @notice Permission for resuming beacon chain deposits on the StakingVault.
     */
    bytes32 public constant RESUME_BEACON_CHAIN_DEPOSITS_ROLE =
        keccak256("StakingVault.Permissions.ResumeBeaconChainDeposits");

    /**
     * @notice Permission for requesting validator exit from the StakingVault.
     */
    bytes32 public constant REQUEST_VALIDATOR_EXIT_ROLE = keccak256("StakingVault.Permissions.RequestValidatorExit");

    /**
     * @notice Permission for triggering validator withdrawal from the StakingVault using EIP-7002 triggerable exit.
     */
    bytes32 public constant TRIGGER_VALIDATOR_WITHDRAWAL_ROLE = keccak256("StakingVault.Permissions.TriggerValidatorWithdrawal");

    /**
     * @notice Permission for voluntary disconnecting the StakingVault.
     */
    bytes32 public constant VOLUNTARY_DISCONNECT_ROLE = keccak256("StakingVault.Permissions.VoluntaryDisconnect");

    /**
     * @notice Address of the implementation contract
     * @dev Used to prevent initialization in the implementation
     */
    address private immutable _SELF;

    /**
     * @notice Indicates whether the contract has been initialized
     */
    bool public initialized;

    /**
     * @notice Address of the VaultHub contract
     */
    VaultHub public vaultHub;

    constructor() {
        _SELF = address(this);
    }

    function _initialize(address _defaultAdmin) internal {
        if (initialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");

        initialized = true;
        vaultHub = VaultHub(stakingVault().vaultHub());
        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);

        _setVoteLifetime(7 days);

        emit Initialized();
    }

    function stakingVault() public view returns (IStakingVault) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        address addr;
        assembly {
            addr := mload(add(args, 32))
        }
        return IStakingVault(addr);
    }

    function _votingCommittee() internal pure virtual returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = DEFAULT_ADMIN_ROLE;
        return roles;
    }

    function _fund(uint256 _ether) internal onlyRole(FUND_ROLE) {
        stakingVault().fund{value: _ether}();
    }

    function _withdraw(address _recipient, uint256 _ether) internal virtual onlyRole(WITHDRAW_ROLE) {
        _unsafeWithdraw(_recipient, _ether);
    }

    function _mintShares(address _recipient, uint256 _shares) internal onlyRole(MINT_ROLE) {
        vaultHub.mintSharesBackedByVault(address(stakingVault()), _recipient, _shares);
    }

    function _burnShares(uint256 _shares) internal onlyRole(BURN_ROLE) {
        vaultHub.burnSharesBackedByVault(address(stakingVault()), _shares);
    }

    function _rebalanceVault(uint256 _ether) internal onlyRole(REBALANCE_ROLE) {
        stakingVault().rebalance(_ether);
    }

    function _pauseBeaconChainDeposits() internal onlyRole(PAUSE_BEACON_CHAIN_DEPOSITS_ROLE) {
        stakingVault().pauseBeaconChainDeposits();
    }

    function _resumeBeaconChainDeposits() internal onlyRole(RESUME_BEACON_CHAIN_DEPOSITS_ROLE) {
        stakingVault().resumeBeaconChainDeposits();
    }

    function _requestValidatorExit(bytes calldata _pubkeys) internal onlyRole(REQUEST_VALIDATOR_EXIT_ROLE) {
        stakingVault().requestValidatorExit(_pubkeys);
    }

    function _triggerValidatorWithdrawal(bytes calldata _pubkeys, uint64[] calldata _amounts, address _refundRecipient) internal onlyRole(TRIGGER_VALIDATOR_WITHDRAWAL_ROLE) {
        stakingVault().triggerValidatorWithdrawal{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    function _voluntaryDisconnect() internal onlyRole(VOLUNTARY_DISCONNECT_ROLE) {
        vaultHub.voluntaryDisconnect(address(stakingVault()));
    }

    function _transferStakingVaultOwnership(address _newOwner) internal onlyIfVotedBy(_votingCommittee()) {
        OwnableUpgradeable(address(stakingVault())).transferOwnership(_newOwner);
    }

    function _unsafeWithdraw(address _recipient, uint256 _ether) internal {
        stakingVault().withdraw(_recipient, _ether);
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
