// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlVoteable} from "contracts/0.8.25/utils/AccessControlVoteable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts-v5.2/token/ERC20/extensions/IERC20Permit.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";

import {Math256} from "contracts/common/lib/Math256.sol";

import {VaultHub} from "./VaultHub.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILido as IStETH} from "../interfaces/ILido.sol";

interface IWeth is IERC20 {
    function withdraw(uint) external;

    function deposit() external payable;
}

interface IWstETH is IERC20, IERC20Permit {
    function wrap(uint256) external returns (uint256);

    function unwrap(uint256) external returns (uint256);
}

/**
 * @title Dashboard
 * @notice This contract is meant to be used as the owner of `StakingVault`.
 * This contract improves the vault UX by bundling all functions from the vault and vault hub
 * in this single contract. It provides administrative functions for managing the staking vault,
 * including funding, withdrawing, depositing to the beacon chain, minting, burning, and rebalancing operations.
 * All these functions are only callable by the account with the DEFAULT_ADMIN_ROLE.
 * TODO: need to add recover methods for ERC20, probably in a separate contract
 */
contract Dashboard is AccessControlVoteable {
    /// @notice Address of the implementation contract
    /// @dev Used to prevent initialization in the implementation
    address private immutable _SELF;
    /// @notice Total basis points for fee calculations; equals to 100%.
    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    /// @notice The stETH token contract
    IStETH public immutable STETH;

    /// @notice The wrapped staked ether token contract
    IWstETH public immutable WSTETH;

    /// @notice The wrapped ether token contract
    IWeth public immutable WETH;

    /// @notice Indicates whether the contract has been initialized
    bool public initialized;

    /// @notice The `VaultHub` contract
    VaultHub public vaultHub;

    struct PermitInput {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /**
     * @notice Constructor sets the stETH token address and the implementation contract address.
     * @param _stETH Address of the stETH token contract.
     * @param _weth Address of the weth token contract.
     * @param _wstETH Address of the wstETH token contract.
     */
    constructor(address _stETH, address _weth, address _wstETH) {
        if (_stETH == address(0)) revert ZeroArgument("_stETH");
        if (_weth == address(0)) revert ZeroArgument("_WETH");
        if (_wstETH == address(0)) revert ZeroArgument("_wstETH");

        _SELF = address(this);
        STETH = IStETH(_stETH);
        WETH = IWeth(_weth);
        WSTETH = IWstETH(_wstETH);
    }

    /**
     * @notice Initializes the contract with the default admin
     *         and `vaultHub` address
     */
    function initialize() external virtual {
        _initialize();
    }

    /**
     * @dev Internal initialize function.
     */
    function _initialize() internal {
        if (initialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();

        initialized = true;
        vaultHub = VaultHub(stakingVault().vaultHub());
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        emit Initialized();
    }

    // ==================== View Functions ====================

    /**
     * @notice Returns the vault socket data for the staking vault.
     * @return VaultSocket struct containing vault data
     */
    function vaultSocket() public view returns (VaultHub.VaultSocket memory) {
        return vaultHub.vaultSocket(address(stakingVault()));
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
    function reserveRatio() public view returns (uint16) {
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

    /**
     * @notice Returns the valuation of the vault in ether.
     * @return The valuation as a uint256.
     */
    function valuation() external view returns (uint256) {
        return stakingVault().valuation();
    }

    /**
     * @notice Returns the total of shares that can be minted on the vault bound by valuation and vault share limit.
     * @return The maximum number of stETH shares as a uint256.
     */
    function totalMintableShares() public view returns (uint256) {
        return _totalMintableShares(stakingVault().valuation());
    }

    /**
     * @notice Returns the maximum number of shares that can be minted with deposited ether.
     * @param _ether the amount of ether to be funded, can be zero
     * @return the maximum number of shares that can be minted by ether
     */
    function getMintableShares(uint256 _ether) external view returns (uint256) {
        uint256 _totalShares = _totalMintableShares(stakingVault().valuation() + _ether);
        uint256 _sharesMinted = vaultSocket().sharesMinted;

        if (_totalShares < _sharesMinted) return 0;
        return _totalShares - _sharesMinted;
    }

    /**
     * @notice Returns the amount of ether that can be withdrawn from the staking vault.
     * @return The amount of ether that can be withdrawn.
     */
    function getWithdrawableEther() external view returns (uint256) {
        return Math256.min(address(stakingVault()).balance, stakingVault().unlocked());
    }

    // TODO: add preview view methods for minting and burning

    // ==================== Vault Management Functions ====================

    /**
     * @dev Receive function to accept ether
     */
    // TODO: Consider the amount of ether on balance of the contract
    receive() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
    }

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
     * @notice Funds the staking vault with wrapped ether. Approvals for the passed amounts should be done before.
     * @param _wethAmount Amount of wrapped ether to fund the staking vault with
     */
    function fundByWeth(uint256 _wethAmount) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        if (WETH.allowance(msg.sender, address(this)) < _wethAmount) revert("ERC20: transfer amount exceeds allowance");

        WETH.transferFrom(msg.sender, address(this), _wethAmount);
        WETH.withdraw(_wethAmount);

        // TODO: find way to use _fund() instead of stakingVault directly
        stakingVault().fund{value: _wethAmount}();
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
     * @notice Withdraws stETH tokens from the staking vault to wrapped ether.
     * @param _recipient Address of the recipient
     * @param _ether Amount of ether to withdraw
     */
    function withdrawToWeth(address _recipient, uint256 _ether) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _withdraw(address(this), _ether);
        WETH.deposit{value: _ether}();
        WETH.transfer(_recipient, _ether);
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
     * @notice Mints wstETH tokens backed by the vault to a recipient. Approvals for the passed amounts should be done before.
     * @param _recipient Address of the recipient
     * @param _tokens Amount of tokens to mint
     */
    function mintWstETH(
        address _recipient,
        uint256 _tokens
    ) external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) fundAndProceed {
        _mint(address(this), _tokens);

        STETH.approve(address(WSTETH), _tokens);
        uint256 wstETHAmount = WSTETH.wrap(_tokens);
        WSTETH.transfer(_recipient, wstETHAmount);
    }

    /**
     * @notice Burns stETH shares from the sender backed by the vault
     * @param _amountOfShares Amount of shares to burn
     */
    function burn(uint256 _amountOfShares) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _burn(_amountOfShares);
    }

    /**
     * @notice Burns wstETH tokens from the sender backed by the vault. Approvals for the passed amounts should be done before.
     * @param _tokens Amount of wstETH tokens to burn
     */
    function burnWstETH(uint256 _tokens) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        WSTETH.transferFrom(msg.sender, address(this), _tokens);

        uint256 stETHAmount = WSTETH.unwrap(_tokens);

        STETH.transfer(address(vaultHub), stETHAmount);

        uint256 sharesAmount = STETH.getSharesByPooledEth(stETHAmount);

        vaultHub.burnSharesBackedByVault(address(stakingVault()), sharesAmount);
    }

    /**
     * @dev Modifier to check if the permit is successful, and if not, check if the allowance is sufficient
     */
    modifier trustlessPermit(
        address token,
        address owner,
        address spender,
        PermitInput calldata permitInput
    ) {
        // Try permit() before allowance check to advance nonce if possible
        try
            IERC20Permit(token).permit(
                owner,
                spender,
                permitInput.value,
                permitInput.deadline,
                permitInput.v,
                permitInput.r,
                permitInput.s
            )
        {
            _;
            return;
        } catch {
            // Permit potentially got frontran. Continue anyways if allowance is sufficient.
            if (IERC20(token).allowance(owner, spender) >= permitInput.value) {
                _;
                return;
            }
        }
        revert("Permit failure");
    }

    /**
     * @notice Burns stETH tokens from the sender backed by the vault using EIP-2612 Permit.
     * @param _tokens Amount of stETH tokens to burn
     * @param _permit data required for the stETH.permit() method to set the allowance
     */
    function burnWithPermit(
        uint256 _tokens,
        PermitInput calldata _permit
    )
        external
        virtual
        onlyRole(DEFAULT_ADMIN_ROLE)
        trustlessPermit(address(STETH), msg.sender, address(this), _permit)
    {
        _burn(_tokens);
    }

    /**
     * @notice Burns wstETH tokens from the sender backed by the vault using EIP-2612 Permit.
     * @param _tokens Amount of wstETH tokens to burn
     * @param _permit data required for the wstETH.permit() method to set the allowance
     */
    function burnWstETHWithPermit(
        uint256 _tokens,
        PermitInput calldata _permit
    )
        external
        virtual
        onlyRole(DEFAULT_ADMIN_ROLE)
        trustlessPermit(address(WSTETH), msg.sender, address(this), _permit)
    {
        WSTETH.transferFrom(msg.sender, address(this), _tokens);
        uint256 stETHAmount = WSTETH.unwrap(_tokens);

        STETH.transfer(address(vaultHub), stETHAmount);

        uint256 sharesAmount = STETH.getSharesByPooledEth(stETHAmount);

        vaultHub.burnSharesBackedByVault(address(stakingVault()), sharesAmount);
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
        OwnableUpgradeable(address(stakingVault())).transferOwnership(_newOwner);
    }

    /**
     * @dev Disconnects the staking vault from the vault hub
     */
    function _voluntaryDisconnect() internal {
        uint256 shares = sharesMinted();
        if (shares > 0) {
            _rebalanceVault(STETH.getPooledEthBySharesRoundUp(shares));
        }

        vaultHub.voluntaryDisconnect(address(stakingVault()));
    }

    /**
     * @dev Funds the staking vault with the ether sent in the transaction
     */
    function _fund() internal {
        stakingVault().fund{value: msg.value}();
    }

    /**
     * @dev Withdraws ether from the staking vault to a recipient
     * @param _recipient Address of the recipient
     * @param _ether Amount of ether to withdraw
     */
    function _withdraw(address _recipient, uint256 _ether) internal {
        stakingVault().withdraw(_recipient, _ether);
    }

    /**
     * @dev Requests the exit of a validator from the staking vault
     * @param _validatorPublicKey Public key of the validator to exit
     */
    function _requestValidatorExit(bytes calldata _validatorPublicKey) internal {
        stakingVault().requestValidatorExit(_validatorPublicKey);
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
        stakingVault().depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    /**
     * @dev Mints stETH tokens backed by the vault to a recipient
     * @param _recipient Address of the recipient
     * @param _amountOfShares Amount of tokens to mint
     */
    function _mint(address _recipient, uint256 _amountOfShares) internal {
        vaultHub.mintSharesBackedByVault(address(stakingVault()), _recipient, _amountOfShares);
    }

    /**
     * @dev Burns stETH tokens from the sender backed by the vault
     * @param _amountOfShares Amount of tokens to burn
     */
    function _burn(uint256 _amountOfShares) internal {
        STETH.transferSharesFrom(msg.sender, address(vaultHub), _amountOfShares);
        vaultHub.burnSharesBackedByVault(address(stakingVault()), _amountOfShares);
    }

    /**
     * @dev calculates total shares vault can mint
     * @param _valuation custom vault valuation
     */
    function _totalMintableShares(uint256 _valuation) internal view returns (uint256) {
        uint256 maxMintableStETH = (_valuation * (TOTAL_BASIS_POINTS - vaultSocket().reserveRatioBP)) /
            TOTAL_BASIS_POINTS;
        return Math256.min(STETH.getSharesByPooledEth(maxMintableStETH), vaultSocket().shareLimit);
    }

    /**
     * @dev Rebalances the vault by transferring ether
     * @param _ether Amount of ether to rebalance
     */
    function _rebalanceVault(uint256 _ether) internal {
        stakingVault().rebalance(_ether);
    }

    /// @notice The underlying `StakingVault` contract
    function stakingVault() public view returns (IStakingVault) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        address addr;
        assembly {
            addr := mload(add(args, 32))
        }
        return IStakingVault(addr);
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
