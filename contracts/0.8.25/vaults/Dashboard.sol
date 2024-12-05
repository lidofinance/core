// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.0.2/access/extensions/AccessControlEnumerable.sol";
import {IERC20} from "@openzeppelin/contracts-v5.0.2/token/ERC20/IERC20.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {VaultHub} from "./VaultHub.sol";

/**
 * @title Dashboard
 * @notice This contract is meant to be used as the owner of `StakingVault`.
 * This contract improves the vault UX by bundling all functions from the vault and vault hub
 * in this single contract. It provides administrative functions for managing the staking vault,
 * including funding, withdrawing, depositing to the beacon chain, minting, burning, and rebalancing operations.
 * All these functions are only callable by the account with the DEFAULT_ADMIN_ROLE.
 */
contract Dashboard is AccessControlEnumerable {
    /// @notice Address of the implementation contract
    /// @dev Used to prevent initialization in the implementation
    address private immutable _SELF;

    /// @notice Indicates whether the contract has been initialized
    bool public isInitialized;

    /// @notice The stETH token contract
    IERC20 public immutable stETH;

    /// @notice The underlying `StakingVault` contract
    IStakingVault public stakingVault;

    /// @notice The `VaultHub` contract
    VaultHub public vaultHub;

    /**
     * @notice Constructor sets the stETH token address and the implementation contract address.
     * @param _stETH Address of the stETH token contract.
     */
    constructor(address _stETH) {
        if (_stETH == address(0)) revert ZeroArgument("_stETH");

        _SELF = address(this);
        stETH = IERC20(_stETH);
    }

    /**
     * @notice Initializes the contract with the default admin and `StakingVault` address.
     * @param _defaultAdmin Address to be granted the `DEFAULT_ADMIN_ROLE`, i.e. the actual owner of the stVault
     * @param _stakingVault Address of the `StakingVault` contract.
     */
    function initialize(address _defaultAdmin, address _stakingVault) external virtual {
        _initialize(_defaultAdmin, _stakingVault);
    }

    /**
     * @dev Internal initialize function.
     * @param _defaultAdmin Address to be granted the `DEFAULT_ADMIN_ROLE`
     * @param _stakingVault Address of the `StakingVault` contract.
     */
    function _initialize(address _defaultAdmin, address _stakingVault) internal {
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");
        if (_stakingVault == address(0)) revert ZeroArgument("_stakingVault");
        if (isInitialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();

        isInitialized = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);

        stakingVault = IStakingVault(_stakingVault);
        vaultHub = VaultHub(stakingVault.vaultHub());

        emit Initialized();
    }

    // ==================== View Functions ====================

    /**
     * @notice Returns the vault socket data for the staking vault.
     * @return VaultSocket struct containing vault data
     */
    function vaultSocket() public view returns (VaultHub.VaultSocket memory) {
        return vaultHub.vaultSocket(address(stakingVault));
    }

    /**
     * @notice Returns the stETH share limit of the vault
     * @return The share limit as a uint96
     */
    function shareLimit() external view returns (uint96) {
        return vaultSocket().shareLimit;
    }

    /**
     * @notice Returns the number of stETHshares minted
     * @return The shares minted as a uint96
     */
    function sharesMinted() external view returns (uint96) {
        return vaultSocket().sharesMinted;
    }

    /**
     * @notice Returns the reserve ratio of the vault
     * @return The reserve ratio as a uint16
     */
    function reserveRatio() external view returns (uint16) {
        return vaultSocket().reserveRatio;
    }

    /**
     * @notice Returns the threshold reserve ratio of the vault.
     * @return The threshold reserve ratio as a uint16.
     */
    function thresholdReserveRatio() external view returns (uint16) {
        return vaultSocket().reserveRatioThreshold;
    }

    /**
     * @notice Returns the treasury fee basis points.
     * @return The treasury fee in basis points as a uint16.
     */
    function treasuryFee() external view returns (uint16) {
        return vaultSocket().treasuryFeeBP;
    }

    // ==================== Vault Management Functions ====================

    /**
     * @notice Transfers ownership of the staking vault to a new owner.
     * @param _newOwner Address of the new owner.
     */
    function transferStVaultOwnership(address _newOwner) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _transferStVaultOwnership(_newOwner);
    }

    /**
     * @notice Disconnects the staking vault from the vault hub.
     */
    function disconnectFromVaultHub() external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _disconnectFromVaultHub();
    }

    /**
     * @notice Funds the staking vault with ether
     */
    function fund() external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _fund();
    }

    /**
     * @notice Withdraws ether from the staking vault to a recipient
     * @param _recipient Address of the recipient
     * @param _ether Amount of ether to withdraw
     */
    function withdraw(address _recipient, uint256 _ether) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _withdraw(_recipient, _ether);
    }

    /**
     * @notice Requests the exit of a validator from the staking vault
     * @param _validatorPublicKey Public key of the validator to exit
     */
    function requestValidatorExit(bytes calldata _validatorPublicKey) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requestValidatorExit(_validatorPublicKey);
    }

    /**
     * @notice Deposits validators to the beacon chain
     * @param _numberOfDeposits Number of validator deposits
     * @param _pubkeys Concatenated public keys of the validators
     * @param _signatures Concatenated signatures of the validators
     */
    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    /**
     * @notice Mints stETH tokens backed by the vault to a recipient.
     * @param _recipient Address of the recipient
     * @param _tokens Amount of tokens to mint
     */
    function mint(
        address _recipient,
        uint256 _tokens
    ) external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) fundAndProceed {
        _mint(_recipient, _tokens);
    }

    /**
     * @notice Burns stETH tokens from the sender backed by the vault
     * @param _tokens Amount of tokens to burn
     */
    function burn(uint256 _tokens) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _burn(_tokens);
    }

    /**
     * @notice Rebalances the vault by transferring ether
     * @param _ether Amount of ether to rebalance
     */
    function rebalanceVault(uint256 _ether) external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) fundAndProceed {
        _rebalanceVault(_ether);
    }

    // ==================== Internal Functions ====================

    /**
     * @dev Modifier to fund the staking vault if msg.value > 0
     */
    modifier fundAndProceed() {
        if (msg.value > 0) {
            _fund();
        }
        _;
    }

    /**
     * @dev Transfers ownership of the staking vault to a new owner
     * @param _newOwner Address of the new owner
     */
    function _transferStVaultOwnership(address _newOwner) internal {
        OwnableUpgradeable(address(stakingVault)).transferOwnership(_newOwner);
    }

    /**
     * @dev Disconnects the staking vault from the vault hub
     */
    function _disconnectFromVaultHub() internal {
        vaultHub.disconnectVault(address(stakingVault));
    }

    /**
     * @dev Funds the staking vault with the ether sent in the transaction
     */
    function _fund() internal {
        stakingVault.fund{value: msg.value}();
    }

    /**
     * @dev Withdraws ether from the staking vault to a recipient
     * @param _recipient Address of the recipient
     * @param _ether Amount of ether to withdraw
     */
    function _withdraw(address _recipient, uint256 _ether) internal {
        stakingVault.withdraw(_recipient, _ether);
    }

    /**
     * @dev Requests the exit of a validator from the staking vault
     * @param _validatorPublicKey Public key of the validator to exit
     */
    function _requestValidatorExit(bytes calldata _validatorPublicKey) internal {
        stakingVault.requestValidatorExit(_validatorPublicKey);
    }

    /**
     * @dev Deposits validators to the beacon chain
     * @param _numberOfDeposits Number of validator deposits
     * @param _pubkeys Concatenated public keys of the validators
     * @param _signatures Concatenated signatures of the validators
     */
    function _depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) internal {
        stakingVault.depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    /**
     * @dev Mints stETH tokens backed by the vault to a recipient
     * @param _recipient Address of the recipient
     * @param _tokens Amount of tokens to mint
     */
    function _mint(address _recipient, uint256 _tokens) internal {
        vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, _tokens);
    }

    /**
     * @dev Burns stETH tokens from the sender backed by the vault
     * @param _tokens Amount of tokens to burn
     */
    function _burn(uint256 _tokens) internal {
        stETH.transferFrom(msg.sender, address(vaultHub), _tokens);
        vaultHub.burnStethBackedByVault(address(stakingVault), _tokens);
    }

    /**
     * @dev Rebalances the vault by transferring ether
     * @param _ether Amount of ether to rebalance
     */
    function _rebalanceVault(uint256 _ether) internal {
        stakingVault.rebalance(_ether);
    }

    // ==================== Events ====================

    /// @notice Emitted when the contract is initialized
    event Initialized();

    // ==================== Errors ====================

    /// @notice Error for zero address arguments
    /// @param argName Name of the argument that is zero
    error ZeroArgument(string argName);

    /// @notice Error when the withdrawable amount is insufficient.
    /// @param withdrawable The amount that is withdrawable
    /// @param requested The amount requested to withdraw
    error InsufficientWithdrawableAmount(uint256 withdrawable, uint256 requested);

    /// @notice Error when direct calls to the implementation are forbidden
    error NonProxyCallsForbidden();

    /// @notice Error when the contract is already initialized.
    error AlreadyInitialized();
}