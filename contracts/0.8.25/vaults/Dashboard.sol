// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Permissions} from "./Permissions.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {SafeERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/utils/SafeERC20.sol";

import {Math256} from "contracts/common/lib/Math256.sol";
import {VaultHub} from "./VaultHub.sol";

import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts-v5.2/token/ERC721/IERC721.sol";
import {IERC20Permit} from "@openzeppelin/contracts-v5.2/token/ERC20/extensions/IERC20Permit.sol";
import {ILido as IStETH} from "contracts/0.8.25/interfaces/ILido.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

interface IWETH9 is IERC20 {
    function withdraw(uint256) external;

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
    /**
     * @notice Struct containing an account and a role for granting/revoking roles.
     */
    struct RoleAssignment {
        address account;
        bytes32 role;
    }

    /**
     * @notice Total basis points for fee calculations; equals to 100%.
     */
    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    /**
     * @notice The stETH token contract
     */
    IStETH public immutable STETH;

    /**
     * @notice The wstETH token contract
     */
    IWstETH public immutable WSTETH;

    /**
     * @notice The wETH token contract
     */
    IWETH9 public immutable WETH;

    /**
     * @notice ETH address convention per EIP-7528
     */
    address public constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /**
     * @notice Struct containing the permit details.
     */
    struct PermitInput {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /**
     * @notice Constructor sets the stETH, WETH, and WSTETH token addresses.
     * @param _weth Address of the weth token contract.
     * @param _lidoLocator Address of the Lido locator contract.
     */
    constructor(address _weth, address _lidoLocator) Permissions() {
        if (_weth == address(0)) revert ZeroArgument("_WETH");
        if (_lidoLocator == address(0)) revert ZeroArgument("_lidoLocator");

        WETH = IWETH9(_weth);
        STETH = IStETH(ILidoLocator(_lidoLocator).lido());
        WSTETH = IWstETH(ILidoLocator(_lidoLocator).wstETH());
    }

    /**
     * @notice Initializes the contract with the default admin
     *         and `vaultHub` address
     */
    function initialize(address _defaultAdmin) external virtual {
        // reduces gas cost for `mintWsteth`
        // dashboard will hold STETH during this tx
        STETH.approve(address(WSTETH), type(uint256).max);

        _initialize(_defaultAdmin);
    }

    // ==================== View Functions ====================

    function votingCommittee() external pure returns (bytes32[] memory) {
        return _votingCommittee();
    }

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
     * @notice Returns the maximum number of shares that can be minted with funded ether.
     * @param _etherToFund the amount of ether to be funded, can be zero
     * @return the maximum number of shares that can be minted by ether
     */
    function projectedNewMintableShares(uint256 _etherToFund) external view returns (uint256) {
        uint256 _totalShares = _totalMintableShares(stakingVault().valuation() + _etherToFund);
        uint256 _sharesMinted = vaultSocket().sharesMinted;

        if (_totalShares < _sharesMinted) return 0;
        return _totalShares - _sharesMinted;
    }

    /**
     * @notice Returns the amount of ether that can be withdrawn from the staking vault.
     * @return The amount of ether that can be withdrawn.
     */
    function withdrawableEther() external view returns (uint256) {
        return Math256.min(address(stakingVault()).balance, stakingVault().unlocked());
    }

    // ==================== Vault Management Functions ====================

    /**
     * @dev Receive function to accept ether
     */
    receive() external payable {}

    /**
     * @notice Transfers ownership of the staking vault to a new owner.
     * @param _newOwner Address of the new owner.
     */
    function transferStakingVaultOwnership(address _newOwner) external {
        _transferStakingVaultOwnership(_newOwner);
    }

    /**
     * @notice Disconnects the staking vault from the vault hub.
     */
    function voluntaryDisconnect() external payable fundAndProceed {
        uint256 shares = vaultHub.vaultSocket(address(stakingVault())).sharesMinted;

        if (shares > 0) {
            _rebalanceVault(STETH.getPooledEthBySharesRoundUp(shares));
        }

        _voluntaryDisconnect();
    }

    /**
     * @notice Funds the staking vault with ether
     */
    function fund() external payable {
        _fund(msg.value);
    }

    /**
     * @notice Funds the staking vault with wrapped ether. Expects WETH amount apporved to this contract. Auth is perfomed in _fund
     * @param _amountWETH Amount of wrapped ether to fund the staking vault with
     */
    function fundWeth(uint256 _amountWETH) external {
        SafeERC20.safeTransferFrom(WETH, msg.sender, address(this), _amountWETH);
        WETH.withdraw(_amountWETH);

        _fund(_amountWETH);
    }

    /**
     * @notice Withdraws ether from the staking vault to a recipient
     * @param _recipient Address of the recipient
     * @param _ether Amount of ether to withdraw
     */
    function withdraw(address _recipient, uint256 _ether) external {
        _withdraw(_recipient, _ether);
    }

    /**
     * @notice Withdraws stETH tokens from the staking vault to wrapped ether.
     * @param _recipient Address of the recipient
     * @param _amountWETH Amount of WETH to withdraw
     */
    function withdrawWeth(address _recipient, uint256 _amountWETH) external {
        _withdraw(address(this), _amountWETH);
        WETH.deposit{value: _amountWETH}();
        SafeERC20.safeTransfer(WETH, _recipient, _amountWETH);
    }

    /**
     * @notice Requests the exit of a validator from the staking vault
     * @param _validatorPublicKey Public key of the validator to exit
     */
    function requestValidatorExit(bytes calldata _validatorPublicKey) external {
        _requestValidatorExit(_validatorPublicKey);
    }

    /**
     * @notice Mints stETH tokens backed by the vault to the recipient.
     * @param _recipient Address of the recipient
     * @param _amountShares Amount of stETH shares to mint
     */
    function mintShares(address _recipient, uint256 _amountShares) external payable fundAndProceed {
        _mintShares(_recipient, _amountShares);
    }

    /**
     * @notice Mints stETH tokens backed by the vault to the recipient.
     * !NB: this will revert with`VaultHub.ZeroArgument("_amountOfShares")` if the amount of stETH is less than 1 share
     * @param _recipient Address of the recipient
     * @param _amountStETH Amount of stETH to mint
     */
    function mintStETH(address _recipient, uint256 _amountStETH) external payable virtual fundAndProceed {
        _mintShares(_recipient, STETH.getSharesByPooledEth(_amountStETH));
    }

    /**
     * @notice Mints wstETH tokens backed by the vault to a recipient.
     * @param _recipient Address of the recipient
     * @param _amountWstETH Amount of tokens to mint
     */
    function mintWstETH(address _recipient, uint256 _amountWstETH) external payable fundAndProceed {
        _mintShares(address(this), _amountWstETH);

        uint256 mintedStETH = STETH.getPooledEthBySharesRoundUp(_amountWstETH);

        uint256 wrappedWstETH = WSTETH.wrap(mintedStETH);
        WSTETH.transfer(_recipient, wrappedWstETH);
    }

    /**
     * @notice Burns stETH shares from the sender backed by the vault. Expects corresponding amount of stETH apporved to this contract.
     * @param _amountShares Amount of stETH shares to burn
     */
    function burnShares(uint256 _amountShares) external {
        STETH.transferSharesFrom(msg.sender, address(vaultHub), _amountShares);
        _burnShares(_amountShares);
    }

    /**
     * @notice Burns stETH shares from the sender backed by the vault. Expects stETH amount apporved to this contract.
     * !NB: this will revert with `VaultHub.ZeroArgument("_amountOfShares")` if the amount of stETH is less than 1 share
     * @param _amountStETH Amount of stETH shares to burn
     */
    function burnSteth(uint256 _amountStETH) external {
        _burnStETH(_amountStETH);
    }

    /**
     * @notice Burns wstETH tokens from the sender backed by the vault. Expects wstETH amount apporved to this contract.
     * !NB: this will revert with `VaultHub.ZeroArgument("_amountOfShares")` on 1 wei of wstETH due to rounding insie wstETH unwrap method
     * @param _amountWstETH Amount of wstETH tokens to burn

     */
    function burnWstETH(uint256 _amountWstETH) external {
        _burnWstETH(_amountWstETH);
    }

    /**
     * @dev Modifier to check if the permit is successful, and if not, check if the allowance is sufficient
     */
    modifier safePermit(
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
        revert InvalidPermit(token);
    }

    /**
     * @notice Burns stETH tokens (in shares) backed by the vault from the sender using permit (with value in stETH).
     * @param _amountShares Amount of stETH shares to burn
     * @param _permit data required for the stETH.permit() with amount in stETH
     */
    function burnSharesWithPermit(
        uint256 _amountShares,
        PermitInput calldata _permit
    ) external virtual safePermit(address(STETH), msg.sender, address(this), _permit) {
        STETH.transferSharesFrom(msg.sender, address(vaultHub), _amountShares);
        _burnShares(_amountShares);
    }

    /**
     * @notice Burns stETH tokens backed by the vault from the sender using permit.
     * !NB: this will revert with `VaultHub.ZeroArgument("_amountOfShares")` if the amount of stETH is less than 1 share
     * @param _amountStETH Amount of stETH to burn
     * @param _permit data required for the stETH.permit() method to set the allowance
     */
    function burnStethWithPermit(
        uint256 _amountStETH,
        PermitInput calldata _permit
    ) external safePermit(address(STETH), msg.sender, address(this), _permit) {
        _burnStETH(_amountStETH);
    }

    /**
     * @notice Burns wstETH tokens backed by the vault from the sender using EIP-2612 Permit.
     * !NB: this will revert with `VaultHub.ZeroArgument("_amountOfShares")` on 1 wei of wstETH due to rounding inside wstETH unwrap method
     * @param _amountWstETH Amount of wstETH tokens to burn
     * @param _permit data required for the wstETH.permit() method to set the allowance
     */
    function burnWstETHWithPermit(
        uint256 _amountWstETH,
        PermitInput calldata _permit
    ) external safePermit(address(WSTETH), msg.sender, address(this), _permit) {
        _burnWstETH(_amountWstETH);
    }

    /**
     * @notice Rebalances the vault by transferring ether
     * @param _ether Amount of ether to rebalance
     */
    function rebalanceVault(uint256 _ether) external payable fundAndProceed {
        _rebalanceVault(_ether);
    }

    /**
     * @notice recovers ERC20 tokens or ether from the dashboard contract to sender
     * @param _token Address of the token to recover or 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee for ether
     * @param _recipient Address of the recovery recipient
     */
    function recoverERC20(address _token, address _recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroArgument("_token");
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        uint256 _amount;

        if (_token == ETH) {
            _amount = address(this).balance;
            (bool success, ) = payable(_recipient).call{value: _amount}("");
            if (!success) revert EthTransferFailed(_recipient, _amount);
        } else {
            _amount = IERC20(_token).balanceOf(address(this));
            SafeERC20.safeTransfer(IERC20(_token), _recipient, _amount);
        }

        emit ERC20Recovered(_recipient, _token, _amount);
    }

    /**
     * @notice Transfers a given token_id of an ERC721-compatible NFT (defined by the token contract address)
     * from the dashboard contract to sender
     *
     * @param _token an ERC721-compatible token
     * @param _tokenId token id to recover
     * @param _recipient Address of the recovery recipient
     */
    function recoverERC721(address _token, uint256 _tokenId, address _recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroArgument("_token");
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        IERC721(_token).safeTransferFrom(address(this), _recipient, _tokenId);

        emit ERC721Recovered(_recipient, _token, _tokenId);
    }

    /**
     * @notice Pauses beacon chain deposits on the StakingVault.
     */
    function pauseBeaconChainDeposits() external {
        _pauseBeaconChainDeposits();
    }

    /**
     * @notice Resumes beacon chain deposits on the StakingVault.
     */
    function resumeBeaconChainDeposits() external {
        _resumeBeaconChainDeposits();
    }

    // ==================== Role Management Functions ====================

    /**
     * @notice Mass-grants multiple roles to multiple accounts.
     * @param _assignments An array of role assignments.
     * @dev Performs the role admin checks internally.
     */
    function grantRoles(RoleAssignment[] memory _assignments) external {
        if (_assignments.length == 0) revert ZeroArgument("_assignments");

        for (uint256 i = 0; i < _assignments.length; i++) {
            grantRole(_assignments[i].role, _assignments[i].account);
        }
    }

    /**
     * @notice Mass-revokes multiple roles from multiple accounts.
     * @param _assignments An array of role assignments.
     * @dev Performs the role admin checks internally.
     */
    function revokeRoles(RoleAssignment[] memory _assignments) external {
        if (_assignments.length == 0) revert ZeroArgument("_assignments");

        for (uint256 i = 0; i < _assignments.length; i++) {
            revokeRole(_assignments[i].role, _assignments[i].account);
        }
    }

    // ==================== Internal Functions ====================

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

    /**
     * @dev Burns stETH tokens from the sender backed by the vault
     * @param _amountStETH Amount of tokens to burn
     */
    function _burnStETH(uint256 _amountStETH) internal {
        uint256 _amountShares = STETH.getSharesByPooledEth(_amountStETH);
        STETH.transferSharesFrom(msg.sender, address(vaultHub), _amountShares);
        _burnShares(_amountShares);
    }

    /**
     * @dev Burns wstETH tokens from the sender backed by the vault
     * @param _amountWstETH Amount of tokens to burn
     */
    function _burnWstETH(uint256 _amountWstETH) internal {
        WSTETH.transferFrom(msg.sender, address(this), _amountWstETH);
        uint256 unwrappedStETH = WSTETH.unwrap(_amountWstETH);
        uint256 unwrappedShares = STETH.getSharesByPooledEth(unwrappedStETH);

        STETH.transferShares(address(vaultHub), unwrappedShares);
        _burnShares(unwrappedShares);
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

    /// @notice Emitted when the ERC20 `token` or Ether is recovered (i.e. transferred)
    /// @param to The address of the recovery recipient
    /// @param token The address of the recovered ERC20 token (zero address for Ether)
    /// @param amount The amount of the token recovered
    event ERC20Recovered(address indexed to, address indexed token, uint256 amount);

    /// @notice Emitted when the ERC721-compatible `token` (NFT) recovered  (i.e. transferred)
    /// @param to The address of the recovery recipient
    /// @param token The address of the recovered ERC721 token
    /// @param tokenId id of token recovered
    event ERC721Recovered(address indexed to, address indexed token, uint256 tokenId);

    // ==================== Errors ====================

    /// @notice Error when provided permit is invalid
    error InvalidPermit(address token);

    /// @notice Error when recovery of ETH fails on transfer to recipient
    error EthTransferFailed(address recipient, uint256 amount);
}
