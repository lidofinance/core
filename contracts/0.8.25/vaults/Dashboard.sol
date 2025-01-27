// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Permissions} from "./Permissions.sol";
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
contract Dashboard is Permissions {
    /// @notice Address of the implementation contract
    /// @dev Used to prevent initialization in the implementation
    address private immutable _SELF;
    /// @notice Total basis points for fee calculations; equals to 100%.
    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    /// @notice Indicates whether the contract has been initialized
    bool public initialized;

    /// @notice The stETH token contract
    IStETH private immutable STETH;

    /// @notice The wrapped staked ether token contract
    IWstETH private immutable WSTETH;

    /// @notice The wrapped ether token contract
    IWeth private immutable WETH;

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
     * @param _steth Address of the stETH token contract.
     * @param _weth Address of the weth token contract.
     * @param _wsteth Address of the wstETH token contract.
     */
    constructor(address _steth, address _weth, address _wsteth) {
        if (_steth == address(0)) revert ZeroArgument("_steth");
        if (_weth == address(0)) revert ZeroArgument("_weth");
        if (_wsteth == address(0)) revert ZeroArgument("_wsteth");

        _SELF = address(this);
        STETH = IStETH(_steth);
        WETH = IWeth(_weth);
        WSTETH = IWstETH(_wsteth);
    }

    /**
     * @notice Initializes the contract with the default admin
     *         and `vaultHub` address
     */
    function initialize(address _defaultAdmin) external virtual {
        _initialize(_defaultAdmin);
    }

    /**
     * @dev Internal initialize function.
     */
    function _initialize(address _defaultAdmin) internal {
        if (initialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();

        initialized = true;
        vaultHub = VaultHub(_stakingVault().vaultHub());
        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);

        emit Initialized();
    }

    // ==================== View Functions ====================

    /// @notice The underlying `StakingVault` contract
    function stakingVault() external view returns (address) {
        return address(_stakingVault());
    }

    function stETH() external view returns (address) {
        return address(STETH);
    }

    function wETH() external view returns (address) {
        return address(WETH);
    }

    function wstETH() external view returns (address) {
        return address(WSTETH);
    }

    function votingCommittee() external pure returns (bytes32[] memory) {
        return _votingCommittee();
    }

    /**
     * @notice Returns the vault socket data for the staking vault.
     * @return VaultSocket struct containing vault data
     */
    function vaultSocket() public view returns (VaultHub.VaultSocket memory) {
        return vaultHub.vaultSocket(address(_stakingVault()));
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
        return _stakingVault().valuation();
    }

    /**
     * @notice Returns the total of shares that can be minted on the vault bound by valuation and vault share limit.
     * @return The maximum number of stETH shares as a uint256.
     */
    function totalMintableShares() public view returns (uint256) {
        return _totalMintableShares(_stakingVault().valuation());
    }

    /**
     * @notice Returns the maximum number of shares that can be minted with deposited ether.
     * @param _ether the amount of ether to be funded, can be zero
     * @return the maximum number of shares that can be minted by ether
     */
    function getMintableShares(uint256 _ether) external view returns (uint256) {
        uint256 _totalShares = _totalMintableShares(_stakingVault().valuation() + _ether);
        uint256 _sharesMinted = vaultSocket().sharesMinted;

        if (_totalShares < _sharesMinted) return 0;
        return _totalShares - _sharesMinted;
    }

    /**
     * @notice Returns the amount of ether that can be withdrawn from the staking vault.
     * @return The amount of ether that can be withdrawn.
     */
    function getWithdrawableEther() external view returns (uint256) {
        return Math256.min(address(_stakingVault()).balance, _stakingVault().unlocked());
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
    function transferOwnership(address _newOwner) external {
        super._transferOwnership(_newOwner);
    }

    /**
     * @notice Disconnects the staking vault from the vault hub.
     */
    function voluntaryDisconnect() external payable fundAndProceed {
        super._voluntaryDisconnect();
    }

    /**
     * @notice Funds the staking vault with ether
     */
    function fund() external payable {
        super._fund(msg.value);
    }

    /**
     * @notice Funds the staking vault with wrapped ether. Approvals for the passed amounts should be done before.
     * @param _wethAmount Amount of wrapped ether to fund the staking vault with
     */
    function fundByWeth(uint256 _wethAmount) external {
        if (WETH.allowance(msg.sender, address(this)) < _wethAmount) revert("ERC20: transfer amount exceeds allowance");

        WETH.transferFrom(msg.sender, address(this), _wethAmount);
        WETH.withdraw(_wethAmount);

        super._fund(_wethAmount);
    }

    /**
     * @notice Withdraws ether from the staking vault to a recipient
     * @param _recipient Address of the recipient
     * @param _ether Amount of ether to withdraw
     */
    function withdraw(address _recipient, uint256 _ether) external {
        super._withdraw(_recipient, _ether);
    }

    /**
     * @notice Withdraws stETH tokens from the staking vault to wrapped ether.
     * @param _recipient Address of the recipient
     * @param _ether Amount of ether to withdraw
     */
    function withdrawToWeth(address _recipient, uint256 _ether) external virtual onlyRole(WITHDRAW_ROLE) {
        super._withdraw(address(this), _ether);
        WETH.deposit{value: _ether}();
        WETH.transfer(_recipient, _ether);
    }

    /**
     * @notice Requests the exit of a validator from the staking vault
     * @param _validatorPublicKey Public key of the validator to exit
     */
    function requestValidatorExit(bytes calldata _validatorPublicKey) external onlyRole(REQUEST_VALIDATOR_EXIT_ROLE) {
        super._requestValidatorExit(_validatorPublicKey);
    }

    /**
     * @notice Mints stETH tokens backed by the vault to a recipient.
     * @param _recipient Address of the recipient
     * @param _amountOfShares Amount of shares to mint
     */
    function mint(
        address _recipient,
        uint256 _amountOfShares
    ) external payable virtual onlyRole(MINT_ROLE) fundAndProceed {
        super._mint(_recipient, _amountOfShares);
    }

    /**
     * @notice Mints wstETH tokens backed by the vault to a recipient. Approvals for the passed amounts should be done before.
     * @param _recipient Address of the recipient
     * @param _tokens Amount of tokens to mint
     */
    function mintWstETH(
        address _recipient,
        uint256 _tokens
    ) external payable virtual onlyRole(MINT_ROLE) fundAndProceed {
        super._mint(address(this), _tokens);

        STETH.approve(address(WSTETH), _tokens);
        uint256 wstETHAmount = WSTETH.wrap(_tokens);
        WSTETH.transfer(_recipient, wstETHAmount);
    }

    /**
     * @notice Burns stETH shares from the sender backed by the vault
     * @param _shares Amount of shares to burn
     */
    function burn(uint256 _shares) external {
        _stETH().transferSharesFrom(msg.sender, address(_vaultHub()), _shares);
        super._burn(_shares);
    }

    /**
     * @notice Burns wstETH tokens from the sender backed by the vault. Approvals for the passed amounts should be done before.
     * @param _tokens Amount of wstETH tokens to burn
     */
    function burnWstETH(uint256 _tokens) external {
        WSTETH.transferFrom(msg.sender, address(this), _tokens);

        uint256 stETHAmount = WSTETH.unwrap(_tokens);

        STETH.transfer(address(vaultHub), stETHAmount);

        uint256 sharesAmount = STETH.getSharesByPooledEth(stETHAmount);

        super._burn(sharesAmount);
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
    ) external trustlessPermit(address(STETH), msg.sender, address(this), _permit) {
        super._burn(_tokens);
    }

    /**
     * @notice Burns wstETH tokens from the sender backed by the vault using EIP-2612 Permit.
     * @param _tokens Amount of wstETH tokens to burn
     * @param _permit data required for the wstETH.permit() method to set the allowance
     */
    function burnWstETHWithPermit(
        uint256 _tokens,
        PermitInput calldata _permit
    ) external trustlessPermit(address(WSTETH), msg.sender, address(this), _permit) {
        WSTETH.transferFrom(msg.sender, address(this), _tokens);
        uint256 stETHAmount = WSTETH.unwrap(_tokens);

        STETH.transfer(address(vaultHub), stETHAmount);

        uint256 sharesAmount = STETH.getSharesByPooledEth(stETHAmount);

        super._burn(sharesAmount);
    }

    /**
     * @notice Rebalances the vault by transferring ether
     * @param _ether Amount of ether to rebalance
     */
    function rebalanceVault(uint256 _ether) external payable fundAndProceed {
        super._rebalanceVault(_ether);
    }

    // ==================== Internal Functions ====================

    function _stakingVault() internal view override returns (IStakingVault) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        address addr;
        assembly {
            addr := mload(add(args, 32))
        }
        return IStakingVault(addr);
    }

    function _vaultHub() internal view override returns (VaultHub) {
        return vaultHub;
    }

    function _stETH() internal view override returns (IStETH) {
        return STETH;
    }

    function _votingCommittee() internal pure virtual override returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = DEFAULT_ADMIN_ROLE;
        return roles;
    }

    /**
     * @dev Modifier to fund the staking vault if msg.value > 0
     */
    modifier fundAndProceed() {
        if (msg.value > 0) {
            _fund(msg.value);
        }
        _;
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

    // ==================== Events ====================

    /// @notice Emitted when the contract is initialized
    event Initialized();

    // ==================== Errors ====================

    /// @notice Error when the withdrawable amount is insufficient.
    /// @param withdrawable The amount that is withdrawable
    /// @param requested The amount requested to withdraw
    error InsufficientWithdrawableAmount(uint256 withdrawable, uint256 requested);

    /// @notice Error when direct calls to the implementation are forbidden
    error NonProxyCallsForbidden();

    /// @notice Error when the contract is already initialized.
    error AlreadyInitialized();

    /// @notice Error when the lengths of the arrays are not equal
    error UnequalLengths();
}
