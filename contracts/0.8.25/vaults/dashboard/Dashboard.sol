// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {SafeERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/utils/SafeERC20.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts-v5.2/token/ERC721/IERC721.sol";

import {ILido as IStETH} from "contracts/0.8.25/interfaces/ILido.sol";

import {IStakingVault, StakingVaultDeposit} from "../interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "../interfaces/IPredepositGuarantee.sol";
import {NodeOperatorFee} from "./NodeOperatorFee.sol";
import {VaultHub} from "../VaultHub.sol";

interface IWstETH is IERC20 {
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
     * @notice Constructor sets the stETH, and WSTETH token addresses,
     * and passes the address of the vault hub up the inheritance chain.
     * @param _stETH Address of the stETH token contract.
     * @param _wstETH Address of the wstETH token contract.
     * @param _vaultHub Address of the vault hub contract.
     * @param _predepositGuarantee Address of the predeposit guarantee contract.
     */
    constructor(
        address _stETH,
        address _wstETH,
        address _vaultHub,
        address _predepositGuarantee
    ) NodeOperatorFee(_vaultHub, _predepositGuarantee) {
        if (_stETH == address(0)) revert ZeroArgument("_stETH");
        if (_wstETH == address(0)) revert ZeroArgument("_wstETH");

        STETH = IStETH(_stETH);
        WSTETH = IWstETH(_wstETH);
    }

    /**
     * @notice Calls the parent's initializer and approves the max allowance for WSTETH for gas savings
     * @param _defaultAdmin The address of the default admin
     * @param _nodeOperatorManager The address of the node operator manager
     * @param _nodeOperatorFeeBP The node operator fee in basis points
     * @param _confirmExpiry The confirmation expiry time in seconds
     */
    function initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) public {
        super._initialize(_defaultAdmin, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);

        // reduces gas cost for `mintWsteth`
        // invariant: dashboard does not hold stETH on its balance
        STETH.approve(address(WSTETH), type(uint256).max);
    }

    // ==================== View Functions ====================

    /**
     * @notice Returns the vault socket data for the staking vault.
     * @return VaultSocket struct containing vault data
     */
    function vaultSocket() public view returns (VaultHub.VaultSocket memory) {
        return VAULT_HUB.vaultSocket(address(_stakingVault()));
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
    function liabilityShares() public view returns (uint96) {
        return vaultSocket().liabilityShares;
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
    function forcedRebalanceThresholdBP() external view returns (uint16) {
        return vaultSocket().forcedRebalanceThresholdBP;
    }

    /**
     * @notice Returns the treasury fee basis points.
     * @return The treasury fee in basis points as a uint16.
     */
    function treasuryFeeBP() external view returns (uint16) {
        return vaultSocket().treasuryFeeBP;
    }

    /**
     * @notice Returns the total value of the vault in ether.
     * @return The total value as a uint256.
     */
    function totalValue() public view returns (uint256) {
        return VAULT_HUB.totalValue(address(_stakingVault()));
    }

    function locked() public view returns (uint256) {
        return VAULT_HUB.vaultSocket(address(_stakingVault())).locked;
    }

    /**
     * @notice Returns the overall capacity for stETH shares that can be minted by the vault
     * @return The maximum number of mintable stETH shares.
     */
    function totalMintingCapacity() public view returns (uint256) {
        return _totalMintingCapacity(0);
    }

    /**
     * @notice Returns the remaining capacity for stETH shares that can be minted
     *         by the vault if additional ether is funded
     * @param _etherToFund the amount of ether to be funded, can be zero
     * @return the number of shares that can be minted using additional ether
     */
    function remainingMintingCapacity(uint256 _etherToFund) external view returns (uint256) {
        uint256 totalShares = _totalMintingCapacity(_etherToFund);
        uint256 liabilityShares_ = vaultSocket().liabilityShares;

        if (totalShares < liabilityShares_) return 0;
        return totalShares - liabilityShares_;
    }

    /**
     * @notice Returns the unreserved amount of ether,
     * i.e. the amount of total value that is not locked in the StakingVault
     * and not reserved for node operator fee.
     * This amount does not account for the current balance of the StakingVault and
     * can return a value greater than the actual balance of the StakingVault.
     * @return uint256: the amount of unreserved ether.
     */
    function unreserved() public view returns (uint256) {
        uint256 reserved = locked() + nodeOperatorUnclaimedFee();
        uint256 totalValue_ = totalValue();

        return reserved > totalValue_ ? 0 : totalValue_ - reserved;
    }

    /**
     * @notice Returns the amount of ether that can be instantly withdrawn from the staking vault.
     * @dev This is the amount of ether that is not locked in the StakingVault and not reserved for node operator fee.
     * @dev This method overrides the Dashboard's withdrawableEther() method
     * @return The amount of ether that can be withdrawn.
     */
    function withdrawableEther() external view returns (uint256) {
        return Math256.min(address(_stakingVault()).balance, unreserved());
    }

    // ==================== Vault Management Functions ====================

    /**
     * @dev Automatically funds the staking vault with ether
     */
    receive() external payable {
        _fund(msg.value);
    }

    /**
     * @notice Sets the owner of the staking vault.
     * @param _newOwner Address of the new owner.
     */
    function setVaultOwner(address _newOwner) external {
        _setVaultOwner(_newOwner);
    }

    /**
     * @notice Disconnects the staking vault from the vault hub.
     * VaultHub stores data for calculating the node operator fee, so the fees should be claimed first.
     */
    function voluntaryDisconnect() external {
        if (nodeOperatorUnclaimedFee() > 0) revert NodeOperatorFeeUnclaimed();

        _voluntaryDisconnect();
    }

    /**
     * @notice Accepts the ownership over the staking vault transferred from VaultHub on disconnect
     * and immediately transfers it to a new pending owner. This new owner will have to accept the ownership
     * on the staking vault contract.
     * @param _newOwner The address to transfer the staking vault ownership to.
     */
    function abandonDashboard(address _newOwner) external {
        address vaultAddress = address(_stakingVault());
        if (VAULT_HUB.vaultSocket(vaultAddress).vault == vaultAddress) revert ConnectedToVaultHub();

        _acceptOwnership();
        _transferOwnership(_newOwner);
    }

    /**
     * @notice Reclaims the Dashboard contract, transferring the staking vault ownership to the VaultHub.
     * @dev This function is used when the Dashboard contract is no longer needed and the staking vault should be transferred to a new owner.
     */
    function connectToVaultHub() external {
        VAULT_HUB.connectVault(address(_stakingVault()));
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
        uint256 unreserved_ = unreserved();

        if (_ether > unreserved_) {
            revert WithdrawalAmountExceedsUnreserved(_ether, unreserved_);
        }

        _withdraw(_recipient, _ether);
    }

    /**
     * @notice Mints stETH shares backed by the vault to the recipient.
     * @param _recipient Address of the recipient
     * @param _amountOfShares Amount of stETH shares to mint
     */
    function mintShares(address _recipient, uint256 _amountOfShares) external payable fundable {
        _mintShares(_recipient, _amountOfShares);
    }

    /**
     * @notice Mints stETH tokens backed by the vault to the recipient.
     * !NB: this will revert with`VaultHub.ZeroArgument("_amountOfShares")` if the amount of stETH is less than 1 share
     * @param _recipient Address of the recipient
     * @param _amountOfStETH Amount of stETH to mint
     */
    function mintStETH(address _recipient, uint256 _amountOfStETH) external payable fundable {
        _mintShares(_recipient, STETH.getSharesByPooledEth(_amountOfStETH));
    }

    /**
     * @notice Mints wstETH tokens backed by the vault to a recipient.
     * @param _recipient Address of the recipient
     * @param _amountOfWstETH Amount of tokens to mint
     */
    function mintWstETH(address _recipient, uint256 _amountOfWstETH) external payable fundable {
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
        STETH.transferSharesFrom(msg.sender, address(VAULT_HUB), _amountOfShares);
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
        IStakingVault stakingVault_ = _stakingVault();

        for (uint256 i = 0; i < _deposits.length; i++) {
            totalAmount += _deposits[i].amount;
        }

        if (totalAmount > unreserved()) {
            revert WithdrawalAmountExceedsUnreserved(totalAmount, unreserved());
        }

        _withdrawForUnguaranteedDepositToBeaconChain(totalAmount);
        _setAccruedRewardsAdjustment(accruedRewardsAdjustment + totalAmount);

        bytes memory withdrawalCredentials = bytes.concat(stakingVault_.withdrawalCredentials());

        StakingVaultDeposit calldata deposit;
        for (uint256 i = 0; i < _deposits.length; i++) {
            deposit = _deposits[i];
            stakingVault_.DEPOSIT_CONTRACT().deposit{value: deposit.amount}(
                deposit.pubkey,
                withdrawalCredentials,
                deposit.signature,
                deposit.depositDataRoot
            );

            emit UnguaranteedDeposit(address(stakingVault_), deposit.pubkey, deposit.amount);
        }
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
     * @notice Ossifies the staking vault. WARNING: This operation is irreversible,
     *         once ossified, the vault cannot be upgraded or attached to VaultHub.
     *         This is a one-way operation.
     * @dev    Pins the current vault implementation to prevent further upgrades.
     */
    function ossifyStakingVault() external {
        _ossifyStakingVault();
    }

    /**
     * @notice Requests a change of tier on the OperatorGrid.
     * @param _tierId The tier to change to.
     */
    function requestTierChange(uint256 _tierId) external {
        _requestTierChange(_tierId);
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
     * @notice Returns the value of the staking vault with the node operator fee subtracted,
     *         because the fee cannot be used to mint shares.
     * @return The amount of ether in wei that can be used to mint shares.
     */
    function _mintableValue() internal view returns (uint256) {
        return VAULT_HUB.totalValue(address(_stakingVault())) - nodeOperatorUnclaimedFee();
    }

    /**
     * @notice Mints shares within the mintable total value,
     *         and reverts if the resulting backing is greater than the mintable total value.
     * @param _recipient The address of the recipient.
     * @param _amountOfShares The amount of shares to mint.
     */
    function _mintSharesWithinMintingCapacity(address _recipient, uint256 _amountOfShares) internal {
        _mintShares(_recipient, _amountOfShares);

        uint256 locked_ = locked();
        uint256 mintableValue_ = _mintableValue();

        if (locked_ > mintableValue_) {
            revert MintingCapacityExceeded(locked_, mintableValue_);
        }
    }

    /**
     * @dev Burns stETH tokens from the sender backed by the vault
     * @param _amountOfStETH Amount of tokens to burn
     */
    function _burnStETH(uint256 _amountOfStETH) internal {
        uint256 _amountOfShares = STETH.getSharesByPooledEth(_amountOfStETH);
        STETH.transferSharesFrom(msg.sender, address(VAULT_HUB), _amountOfShares);
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

        STETH.transferShares(address(VAULT_HUB), unwrappedShares);
        _burnShares(unwrappedShares);
    }

    /**
     * @dev calculates the maximum number of stETH shares that can be minted by the vault
     * @param _additionalFunding additional ether that may be funded to the vault
     */
    function _totalMintingCapacity(uint256 _additionalFunding) internal view returns (uint256) {
        uint256 maxMintableStETH = ((_mintableValue() + _additionalFunding) *
            (TOTAL_BASIS_POINTS - vaultSocket().reserveRatioBP)) / TOTAL_BASIS_POINTS;
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
     * @notice Emitted when the unreserved amount of ether is exceeded
     * @param amount The amount of ether that was attempted to be withdrawn
     * @param unreserved The amount of unreserved ether available
     */
    error WithdrawalAmountExceedsUnreserved(uint256 amount, uint256 unreserved);

    /**
     * @notice Error thrown when recovery of ETH fails on transfer to recipient
     */
    error EthTransferFailed(address recipient, uint256 amount);

    /**
     * @notice Error thrown when mintable total value is breached
     */
    error MintingCapacityExceeded(uint256 locked, uint256 mintableValue);

    /**
     * @notice Error when the StakingVault is not connected to the VaultHub.
     */
    error ConnectedToVaultHub();
}
