// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {SafeERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/utils/SafeERC20.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts-v5.2/token/ERC721/IERC721.sol";
import {IERC20Permit} from "@openzeppelin/contracts-v5.2/token/ERC20/extensions/IERC20Permit.sol";

import {IDepositContract} from "contracts/0.8.25/interfaces/IDepositContract.sol";
import {IStakingVault, StakingVaultDeposit} from "../interfaces/IStakingVault.sol";
import {NodeOperatorFee} from "./NodeOperatorFee.sol";
import {VaultHub} from "../VaultHub.sol";
import {ILido as IStETH} from "contracts/0.8.25/interfaces/ILido.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IPredepositGuarantee} from "../interfaces/IPredepositGuarantee.sol";

interface IWstETH is IERC20, IERC20Permit {
    function wrap(uint256) external returns (uint256);

    function unwrap(uint256) external returns (uint256);
}

/**
 * @title Dashboard
 * @notice This contract is a UX-layer for StakingVault and meant to be used as its owner.
 * This contract improves the vault UX by bundling all functions from the StakingVault and VaultHub
 * in this single contract. It provides administrative functions for managing the StakingVault,
 * including funding, withdrawing, minting, burning, and rebalancing operations.
 */
contract Dashboard is NodeOperatorFee {
    bytes32 public constant RECOVER_ASSETS_ROLE = keccak256("vaults.Dashboard.RecoverAssets");

    /**
     * @notice The stETH token contract
     */
    IStETH public immutable STETH;

    /**
     * @notice The wstETH token contract
     */
    IWstETH public immutable WSTETH;

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
     * @notice Constructor sets the stETH, and WSTETH token addresses.
     * @param _lidoLocator Address of the Lido locator contract.
     */
    constructor(address _lidoLocator) {
        if (_lidoLocator == address(0)) revert ZeroArgument("_lidoLocator");

        STETH = IStETH(ILidoLocator(_lidoLocator).lido());
        WSTETH = IWstETH(ILidoLocator(_lidoLocator).wstETH());
    }

    function initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) public override {
        // reduces gas cost for `mintWsteth`
        // invariant: dashboard does not hold stETH on its balance
        STETH.approve(address(WSTETH), type(uint256).max);

        super.initialize(_defaultAdmin, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);
    }

    // ==================== View Functions ====================

    /**
     * @notice Returns the vault socket data for the staking vault.
     * @return VaultSocket struct containing vault data
     */
    function vaultSocket() public view returns (VaultHub.VaultSocket memory) {
        return vaultHub().vaultSocket(_stakingVaultAddress());
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
     * @notice Returns the reserve ratio of the vault in basis points
     * @return The reserve ratio in basis points as a uint16
     */
    function reserveRatioBP() public view returns (uint16) {
        return vaultSocket().reserveRatioBP;
    }

    /**
     * @notice Returns the rebalance threshold of the vault in basis points.
     * @return The rebalance threshold in basis points as a uint16.
     */
    function rebalanceThresholdBP() external view returns (uint16) {
        return vaultSocket().rebalanceThresholdBP;
    }

    /**
     * @notice Returns the treasury fee basis points.
     * @return The treasury fee in basis points as a uint16.
     */
    function treasuryFeeBP() external view returns (uint16) {
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
     * @notice Returns the overall capacity of stETH shares that can be minted by the vault bound by valuation and vault share limit.
     * @return The maximum number of mintable stETH shares not counting already minted ones.
     */
    function totalMintableShares() public view returns (uint256) {
        return _totalMintableShares(_mintableValuation());
    }

    /**
     * @notice Returns the maximum number of shares that can be minted with funded ether.
     * @param _etherToFund the amount of ether to be funded, can be zero
     * @return the maximum number of shares that can be minted by ether
     */
    function projectedNewMintableShares(uint256 _etherToFund) external view returns (uint256) {
        uint256 _totalShares = _totalMintableShares(_mintableValuation() + _etherToFund);
        uint256 _sharesMinted = vaultSocket().sharesMinted;

        if (_totalShares < _sharesMinted) return 0;
        return _totalShares - _sharesMinted;
    }

    /**
     * @notice Returns the amount of ether that can be withdrawn from the staking vault.
     * @dev This is the amount of ether that is not locked in the StakingVault and not reserved for curator and node operator fees.
     * @dev This method overrides the Dashboard's withdrawableEther() method
     * @return The amount of ether that can be withdrawn.
     */
    function withdrawableEther() external view returns (uint256) {
        return Math256.min(_stakingVaultAddress().balance, unreserved());
    }

    // ==================== Vault Management Functions ====================

    /**
     * @dev Automatically funds the staking vault with ether
     */
    receive() external payable {
        _checkRole(FUND_ROLE, msg.sender);
        _fund(msg.value);
    }

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
    function voluntaryDisconnect() external payable fundable {
        uint256 shares = vaultHub().vaultSocket(_stakingVaultAddress()).sharesMinted;

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
     * @notice Withdraws ether from the staking vault to a recipient
     * @param _recipient Address of the recipient
     * @param _ether Amount of ether to withdraw
     */
    function withdraw(address _recipient, uint256 _ether) external {
        _withdraw(_recipient, _ether);
    }

    /**
     * @notice Update the locked amount of the staking vault
     * @param _amount Amount of ether to lock
     */
    function lock(uint256 _amount) external {
        _lock(_amount);
    }

    /**
     * @notice Mints stETH shares backed by the vault to the recipient.
     * @param _recipient Address of the recipient
     * @param _amountOfShares Amount of stETH shares to mint
     */
    function mintShares(
        address _recipient,
        uint256 _amountOfShares
    ) external payable fundable autolock(_amountOfShares) {
        _mintShares(_recipient, _amountOfShares);
    }

    /**
     * @notice Mints stETH tokens backed by the vault to the recipient.
     * !NB: this will revert with`VaultHub.ZeroArgument("_amountOfShares")` if the amount of stETH is less than 1 share
     * @param _recipient Address of the recipient
     * @param _amountOfStETH Amount of stETH to mint
     */
    function mintStETH(
        address _recipient,
        uint256 _amountOfStETH
    ) external payable fundable autolock(STETH.getSharesByPooledEth(_amountOfStETH)) {
        _mintShares(_recipient, STETH.getSharesByPooledEth(_amountOfStETH));
    }

    /**
     * @notice Mints wstETH tokens backed by the vault to a recipient.
     * @param _recipient Address of the recipient
     * @param _amountOfWstETH Amount of tokens to mint
     */
    function mintWstETH(
        address _recipient,
        uint256 _amountOfWstETH
    ) external payable fundable autolock(_amountOfWstETH) {
        _mintShares(address(this), _amountOfWstETH);

        uint256 mintedStETH = STETH.getPooledEthBySharesRoundUp(_amountOfWstETH);

        uint256 wrappedWstETH = WSTETH.wrap(mintedStETH);
        SafeERC20.safeTransfer(WSTETH, _recipient, wrappedWstETH);
    }

    /**
     * @notice Burns stETH shares from the sender backed by the vault. Expects corresponding amount of stETH approved to this contract.
     * @param _amountOfShares Amount of stETH shares to burn
     */
    function burnShares(uint256 _amountOfShares) external {
        STETH.transferSharesFrom(msg.sender, _vaultHubAddress(), _amountOfShares);
        _burnShares(_amountOfShares);
    }

    /**
     * @notice Burns stETH tokens from the sender backed by the vault. Expects stETH amount approved to this contract.
     * !NB: this will revert with `VaultHub.ZeroArgument("_amountOfShares")` if the amount of stETH is less than 1 share
     * @param _amountOfStETH Amount of stETH tokens to burn
     */
    function burnStETH(uint256 _amountOfStETH) external {
        _burnStETH(_amountOfStETH);
    }

    /**
     * @notice Burns wstETH tokens from the sender backed by the vault. Expects wstETH amount approved to this contract.
     * !NB: this will revert with `VaultHub.ZeroArgument("_amountOfShares")` on 1 wei of wstETH due to rounding inside wstETH unwrap method
     * @param _amountOfWstETH Amount of wstETH tokens to burn

     */
    function burnWstETH(uint256 _amountOfWstETH) external {
        _burnWstETH(_amountOfWstETH);
    }

    /**
     * @notice Burns stETH shares backed by the vault from the sender using permit (with value in stETH).
     * @param _amountOfShares Amount of stETH shares to burn
     * @param _permit data required for the stETH.permit() with amount in stETH
     */
    function burnSharesWithPermit(
        uint256 _amountOfShares,
        PermitInput calldata _permit
    ) external virtual safePermit(address(STETH), msg.sender, address(this), _permit) {
        STETH.transferSharesFrom(msg.sender, _vaultHubAddress(), _amountOfShares);
        _burnShares(_amountOfShares);
    }

    /**
     * @notice Burns stETH tokens backed by the vault from the sender using permit.
     * !NB: this will revert with `VaultHub.ZeroArgument("_amountOfShares")` if the amount of stETH is less than 1 share
     * @param _amountOfStETH Amount of stETH to burn
     * @param _permit data required for the stETH.permit() method to set the allowance
     */
    function burnStETHWithPermit(
        uint256 _amountOfStETH,
        PermitInput calldata _permit
    ) external safePermit(address(STETH), msg.sender, address(this), _permit) {
        _burnStETH(_amountOfStETH);
    }

    /**
     * @notice Burns wstETH tokens backed by the vault from the sender using EIP-2612 Permit.
     * !NB: this will revert with `VaultHub.ZeroArgument("_amountOfShares")` on 1 wei of wstETH due to rounding inside wstETH unwrap method
     * @param _amountOfWstETH Amount of wstETH tokens to burn
     * @param _permit data required for the wstETH.permit() method to set the allowance
     */
    function burnWstETHWithPermit(
        uint256 _amountOfWstETH,
        PermitInput calldata _permit
    ) external safePermit(address(WSTETH), msg.sender, address(this), _permit) {
        _burnWstETH(_amountOfWstETH);
    }

    /**
     * @notice Rebalances the vault by transferring ether
     * @param _ether Amount of ether to rebalance
     */
    function rebalanceVault(uint256 _ether) external payable fundable {
        _rebalanceVault(_ether);
    }

    /**
     * @notice Withdraws ether from vault and deposits directly to provided validators bypassing the default PDG process,
     *          allowing validators to be proven post-factum via `proveUnknownValidatorsToPDG`
     *          clearing them for future deposits via `PDG.depositToBeaconChain`
     * @param _deposits array of IStakingVault.Deposit structs containing deposit data
     * @return totalAmount total amount of ether deposited to beacon chain
     * @dev requires the caller to have the `UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE`
     * @dev can be used as PDG shortcut if the node operator is trusted to not frontrun provided deposits
     */
    function unguaranteedDepositToBeaconChain(
        StakingVaultDeposit[] calldata _deposits
    ) public returns (uint256 totalAmount) {
        IStakingVault stakingVault = stakingVault();
        IDepositContract depositContract = stakingVault.DEPOSIT_CONTRACT();

        for (uint256 i = 0; i < _deposits.length; i++) {
            totalAmount += _deposits[i].amount;
        }

        _withdrawForUnguaranteedDepositToBeaconChain(totalAmount);

        bytes memory withdrawalCredentials = bytes.concat(stakingVault.withdrawalCredentials());

        StakingVaultDeposit calldata deposit;
        for (uint256 i = 0; i < _deposits.length; i++) {
            deposit = _deposits[i];
            depositContract.deposit{value: deposit.amount}(
                deposit.pubkey,
                withdrawalCredentials,
                deposit.signature,
                deposit.depositDataRoot
            );

            emit UnguaranteedDeposit(address(stakingVault), deposit.pubkey, deposit.amount);
        }

        _setAccruedRewardsAdjustment(accruedRewardsAdjustment + totalAmount);
    }

    /**
     * @notice Proves validators with correct vault WC if they are unknown to PDG
     * @param _witnesses array of IPredepositGuarantee.ValidatorWitness structs containing proof data for validators
     * @dev requires the caller to have the `PDG_PROVE_VALIDATOR_ROLE`
     */
    function proveUnknownValidatorsToPDG(IPredepositGuarantee.ValidatorWitness[] calldata _witnesses) external {
        _proveUnknownValidatorsToPDG(_witnesses);
    }

    /**
     * @notice Compensates ether of disproven validator's predeposit from PDG to the recipient.
     *         Can be called if validator which was predeposited via `PDG.predeposit` with vault funds
     *         was frontrun by NO's with non-vault WC (effectively NO's stealing the predeposit) and then
     *         proof of the validator's invalidity has been provided via `PDG.proveInvalidValidatorWC`.
     * @param _pubkey of validator that was proven invalid in PDG
     * @param _recipient address to receive the `PDG.PREDEPOSIT_AMOUNT`
     * @dev PDG will revert if _recipient is vault address, use fund() instead to return ether to vault
     * @dev requires the caller to have the `PDG_COMPENSATE_PREDEPOSIT_ROLE`
     */
    function compensateDisprovenPredepositFromPDG(bytes calldata _pubkey, address _recipient) external {
        _compensateDisprovenPredepositFromPDG(_pubkey, _recipient);
    }

    /**
     * @notice Recovers ERC20 tokens or ether from the dashboard contract to sender
     * @param _token Address of the token to recover or 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee for ether
     * @param _recipient Address of the recovery recipient
     */
    function recoverERC20(address _token, address _recipient, uint256 _amount) external onlyRole(RECOVER_ASSETS_ROLE) {
        if (_token == address(0)) revert ZeroArgument("_token");
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_amount == 0) revert ZeroArgument("_amount");

        if (_token == ETH) {
            (bool success, ) = payable(_recipient).call{value: _amount}("");
            if (!success) revert EthTransferFailed(_recipient, _amount);
        } else {
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
    function recoverERC721(
        address _token,
        uint256 _tokenId,
        address _recipient
    ) external onlyRole(RECOVER_ASSETS_ROLE) {
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

    /**
     * @notice Signals to node operators that specific validators should exit from the beacon chain. It DOES NOT
     *         directly trigger the exit - node operators must monitor for request events and handle the exits.
     * @param _pubkeys Concatenated validator public keys (48 bytes each).
     * @dev    Emits `ValidatorExitRequested` event for each validator public key through the `StakingVault`.
     *         This is a voluntary exit request - node operators can choose whether to act on it or not.
     */
    function requestValidatorExit(bytes calldata _pubkeys) external {
        _requestValidatorExit(_pubkeys);
    }

    /**
     * @notice Initiates a withdrawal from validator(s) on the beacon chain using EIP-7002 triggerable withdrawals
     *         Both partial withdrawals (disabled for unhealthy `StakingVault`) and full validator exits are supported.
     * @param _pubkeys Concatenated validator public keys (48 bytes each).
     * @param _amounts Withdrawal amounts in wei for each validator key and must match _pubkeys length.
     *         Set amount to 0 for a full validator exit.
     *         For partial withdrawals, amounts will be trimmed to keep MIN_ACTIVATION_BALANCE on the validator to avoid deactivation
     * @param _refundRecipient Address to receive any fee refunds, if zero, refunds go to msg.sender.
     * @dev    A withdrawal fee must be paid via msg.value.
     *         Use `StakingVault.calculateValidatorWithdrawalFee()` to determine the required fee for the current block.
     */
    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        _triggerValidatorWithdrawal(_pubkeys, _amounts, _refundRecipient);
    }

    /**
     * @notice Authorizes the Lido Vault Hub to manage the staking vault.
     */
    function authorizeLidoVaultHub() external {
        _authorizeLidoVaultHub();
    }

    /**
     * @notice Deauthorizes the Lido Vault Hub from managing the staking vault.
     */
    function deauthorizeLidoVaultHub() external {
        _deauthorizeLidoVaultHub();
    }

    /**
     * @notice Ossifies the staking vault. WARNING: This operation is irreversible,
     *         once ossified, the vault cannot be upgraded or attached to VaultHub.
     *         This is a one-way operation.
     * @dev    Pins the current vault implementation to prevent further upgrades.
     */
    function ossifyStakingVault() external {
        _ossifyStakingVault();
    }

    /**
     * @notice Updates the address of the depositor for the staking vault.
     * @param _depositor Address of the new depositor.
     */
    function setDepositor(address _depositor) external {
        _setDepositor(_depositor);
    }

    /**
     * @notice Zeroes the locked amount of the staking vault.
     *         Can only be called on disconnected from the vault hub vaults.
     */
    function resetLocked() external {
        _resetLocked();
    }

    // ==================== Internal Functions ====================

    /**
     * @dev Modifier to fund the staking vault if msg.value > 0
     */
    modifier fundable() {
        if (msg.value > 0) {
            _fund(msg.value);
        }
        _;
    }

    /**
     * @dev Modifier to increase the locked amount if necessary
     * @param _newShares The number of new shares to mint
     */
    modifier autolock(uint256 _newShares) {
        VaultHub.VaultSocket memory socket = vaultSocket();

        // Calculate the locked amount required to accommodate the new shares
        uint256 requiredLocked = (STETH.getPooledEthBySharesRoundUp(socket.sharesMinted + _newShares) *
            TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - socket.reserveRatioBP);

        // If the required locked amount is greater than the current, increase the locked amount
        if (requiredLocked > stakingVault().locked()) {
            _lock(requiredLocked);
        }

        _;
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
     * @notice Returns the valuation with the node operator fee subtracted,
     *         because the fee cannot be used to mint shares.
     * @return The amount of ether in wei that can be used to mint shares.
     */
    function _mintableValuation() internal view returns (uint256) {
        return stakingVault().valuation() - nodeOperatorUnclaimedFee();
    }

    /**
     * @notice Mints shares within the mintable valuation,
     *         and reverts if the resulting backing is greater than the mintable valuation.
     * @param _recipient The address of the recipient.
     * @param _amountOfShares The amount of shares to mint.
     */
    function _mintSharesWithinMintableValuation(address _recipient, uint256 _amountOfShares) internal {
        _mintShares(_recipient, _amountOfShares);

        uint256 locked = stakingVault().locked();
        uint256 mintableValuation = _mintableValuation();

        if (locked > mintableValuation) {
            revert MintableValuationExceeded(locked, mintableValuation);
        }
    }

    /**
     * @dev Burns stETH tokens from the sender backed by the vault
     * @param _amountOfStETH Amount of tokens to burn
     */
    function _burnStETH(uint256 _amountOfStETH) internal {
        uint256 _amountOfShares = STETH.getSharesByPooledEth(_amountOfStETH);
        STETH.transferSharesFrom(msg.sender, _vaultHubAddress(), _amountOfShares);
        _burnShares(_amountOfShares);
    }

    /**
     * @dev Burns wstETH tokens from the sender backed by the vault
     * @param _amountOfWstETH Amount of tokens to burn
     */
    function _burnWstETH(uint256 _amountOfWstETH) internal {
        SafeERC20.safeTransferFrom(WSTETH, msg.sender, address(this), _amountOfWstETH);
        uint256 unwrappedStETH = WSTETH.unwrap(_amountOfWstETH);
        uint256 unwrappedShares = STETH.getSharesByPooledEth(unwrappedStETH);

        STETH.transferShares(_vaultHubAddress(), unwrappedShares);
        _burnShares(unwrappedShares);
    }

    /**
     * @dev Calculates total shares vault can mint
     * @param _valuation custom vault valuation
     */
    function _totalMintableShares(uint256 _valuation) internal view returns (uint256) {
        uint256 maxMintableStETH = (_valuation * (TOTAL_BASIS_POINTS - vaultSocket().reserveRatioBP)) /
            TOTAL_BASIS_POINTS;
        return Math256.min(STETH.getSharesByPooledEth(maxMintableStETH), vaultSocket().shareLimit);
    }

    // ==================== Events ====================

    /**
     * @notice Emitted when ether was withdrawn from the staking vault and deposited to validators directly bypassing PDG
     * @param stakingVault the address of owned staking vault
     * @param pubkey of the validator to be deposited
     * @param amount of ether deposited to validator
     */
    event UnguaranteedDeposit(address indexed stakingVault, bytes indexed pubkey, uint256 amount);

    /**
     * @notice Emitted when the ERC20 `token` or ether is recovered (i.e. transferred)
     * @param to The address of the recovery recipient
     * @param token The address of the recovered ERC20 token (0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee for ether)
     * @param amount The amount of the token recovered
     */
    event ERC20Recovered(address indexed to, address indexed token, uint256 amount);

    /**
     * @notice Emitted when the ERC721-compatible `token` (NFT) recovered (i.e. transferred)
     * @param to The address of the recovery recipient
     * @param token The address of the recovered ERC721 token
     * @param tokenId id of token recovered
     */
    event ERC721Recovered(address indexed to, address indexed token, uint256 tokenId);

    // ==================== Errors ====================

    /**
     * @notice Error thrown when provided permit is invalid
     */
    error InvalidPermit(address token);

    /**
     * @notice Error thrown when recovery of ETH fails on transfer to recipient
     */
    error EthTransferFailed(address recipient, uint256 amount);

    /**
     * @notice Error thrown when mintable valuation is breached
     */
    error MintableValuationExceeded(uint256 locked, uint256 mintableValuation);
}
