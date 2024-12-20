// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.0.2/access/extensions/AccessControlEnumerable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {VaultHub} from "./VaultHub.sol";
import {ILido as StETH} from "../interfaces/ILido.sol";

/**
 * @title Dashboard
 * @notice This contract is meant to be used as the owner of `StakingVault`.
 * This contract improves the vault UX by bundling all functions from the vault and vault hub
 * in this single contract. It provides administrative functions for managing the staking vault,
 * including funding, withdrawing, depositing to the beacon chain, minting, burning, and rebalancing operations.
 * All these functions are only callable by the account with the DEFAULT_ADMIN_ROLE.
 * TODO: need to add recover methods for ERC20, probably in a separate contract
 */
contract Dashboard is AccessControlEnumerable {
    /// @notice Address of the implementation contract
    /// @dev Used to prevent initialization in the implementation
    address private immutable _SELF;

    /// @notice Indicates whether the contract has been initialized
    bool public isInitialized;

    /// @notice The stETH token contract
    StETH public immutable STETH;

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
        STETH = StETH(_stETH);
    }

    /**
     * @notice Initializes the contract with the default admin and `StakingVault` address.
     * @param _stakingVault Address of the `StakingVault` contract.
     */
    function initialize(address _stakingVault) external virtual {
        _initialize(_stakingVault);
    }

    /**
     * @dev Internal initialize function.
     * @param _stakingVault Address of the `StakingVault` contract.
     */
    function _initialize(address _stakingVault) internal {
        if (_stakingVault == address(0)) revert ZeroArgument("_stakingVault");
        if (isInitialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();

        isInitialized = true;
        stakingVault = IStakingVault(_stakingVault);
        vaultHub = VaultHub(stakingVault.vaultHub());
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

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
    function sharesMinted() public view returns (uint96) {
        return vaultSocket().sharesMinted;
    }

    /**
     * @notice Returns the reserve ratio of the vault
     * @return The reserve ratio as a uint16
     */
    function reserveRatio() external view returns (uint16) {
        return vaultSocket().reserveRatioBP;
    }

    /**
     * @notice Returns the threshold reserve ratio of the vault.
     * @return The threshold reserve ratio as a uint16.
     */
    function thresholdReserveRatio() external view returns (uint16) {
        return vaultSocket().reserveRatioThresholdBP;
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
    function voluntaryDisconnect() external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) fundAndProceed {
        _voluntaryDisconnect();
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
     * @notice Mints stETH tokens backed by the vault to a recipient.
     * @param _recipient Address of the recipient
     * @param _amountOfShares Amount of shares to mint
     */
    function mint(
        address _recipient,
        uint256 _amountOfShares
    ) external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) fundAndProceed {
        _mint(_recipient, _amountOfShares);
    }

    /**
     * @notice Burns stETH shares from the sender backed by the vault
     * @param _amountOfShares Amount of shares to burn
     */
    function burn(uint256 _amountOfShares) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _burn(_amountOfShares);
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
    function _voluntaryDisconnect() internal {
        uint256 shares = sharesMinted();
        if (shares > 0) {
            _rebalanceVault(STETH.getPooledEthBySharesRoundUp(shares));
        }

        vaultHub.voluntaryDisconnect(address(stakingVault));
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
     * @param _amountOfShares Amount of tokens to mint
     */
    function _mint(address _recipient, uint256 _amountOfShares) internal {
        vaultHub.mintSharesBackedByVault(address(stakingVault), _recipient, _amountOfShares);
    }

    /**
     * @dev Burns stETH tokens from the sender backed by the vault
     * @param _amountOfShares Amount of tokens to burn
     */
    function _burn(uint256 _amountOfShares) internal {
        STETH.transferSharesFrom(msg.sender, address(vaultHub), _amountOfShares);
        vaultHub.burnSharesBackedByVault(address(stakingVault), _amountOfShares);
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
