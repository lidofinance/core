// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {SafeERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {RecoverTokens} from "../lib/RecoverTokens.sol";

import {ILido as IStETH} from "contracts/common/interfaces/ILido.sol";
import {IDepositContract} from "contracts/common/interfaces/IDepositContract.sol";

import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "../interfaces/IPredepositGuarantee.sol";
import {NodeOperatorFee} from "./NodeOperatorFee.sol";
import {VaultHub} from "../VaultHub.sol";

interface IWstETH is IERC20 {
    function wrap(uint256 _stETHAmount) external returns (uint256);

    function unwrap(uint256 _wstETHAmount) external returns (uint256);
}

/**
 * @title Dashboard
 * @notice This contract is a UX-layer for StakingVault and meant to be used as its owner.
 * This contract improves the vault UX by bundling all functions from the StakingVault and VaultHub
 * in this single contract. It provides administrative functions for managing the StakingVault,
 * including funding, withdrawing, minting, burning, and rebalancing operations.
 */
contract Dashboard is NodeOperatorFee {
    /// @dev 0xb694d4d19c77484e8f232470d9bf7e10450638db998b577a833d46df71fb6d97
    bytes32 public constant COLLECT_VAULT_ERC20_ROLE = keccak256("vaults.Dashboard.CollectVaultERC20");

    /**
     * @notice The stETH token contract
     */
    IStETH public immutable STETH;

    /**
     * @notice The wstETH token contract
     */
    IWstETH public immutable WSTETH;

    /**
     * @notice Slot for the fund-on-receive flag
     *         keccak256("vaults.Dashboard.fundOnReceive")
     */
    bytes32 public constant FUND_ON_RECEIVE_FLAG_SLOT =
        0x7408b7b034fda7051615c19182918ecb91d753231cffd86f81a45d996d63e038;

    /**
     * @notice The PDG policy modes.
     * "STRICT": deposits require the full PDG process.
     * "ALLOW_PROVE": allows the node operator to prove unknown validators to PDG.
     * "ALLOW_DEPOSIT_AND_PROVE": allows the node operator to perform unguaranteed deposits
     * (bypassing the predeposit requirement) and proving unknown validators.
     */
    enum PDGPolicy {
        STRICT,
        ALLOW_PROVE,
        ALLOW_DEPOSIT_AND_PROVE
    }

    /**
     * @notice Current active PDG policy set by `DEFAULT_ADMIN_ROLE`.
     */
    PDGPolicy public pdgPolicy = PDGPolicy.STRICT;

    /**
     * @notice the amount of node operator fees accrued on the moment of disconnection and secured to be recovered to
     *         the `feeRecipient` address using `recoverFeeLeftover` method
     */
    uint128 public feeLeftover;

    /**
     * @notice Constructor sets the stETH, and WSTETH token addresses,
     * and passes the address of the vault hub up the inheritance chain.
     * @param _stETH Address of the stETH token contract.
     * @param _wstETH Address of the wstETH token contract.
     * @param _vaultHub Address of the vault hub contract.
     * @param _lidoLocator Address of the Lido locator contract.
     */
    constructor(
        address _stETH,
        address _wstETH,
        address _vaultHub,
        address _lidoLocator
    ) NodeOperatorFee(_vaultHub, _lidoLocator) {
        _requireNotZero(_stETH);
        _requireNotZero(_wstETH);

        // stETH and wstETH are cached as immutable to save gas for main operations
        STETH = IStETH(_stETH);
        WSTETH = IWstETH(_wstETH);
    }

    /**
     * @notice Calls the parent's initializer and approves the max allowance for WSTETH for gas savings
     * @param _defaultAdmin The address of the default admin
     * @param _nodeOperatorManager The address of the node operator manager
     * @param _nodeOperatorFeeRecipient The address of the node operator fee recipient
     * @param _nodeOperatorFeeBP The node operator fee in basis points
     * @param _confirmExpiry The confirmation expiry time in seconds
     */
    function initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        address _nodeOperatorFeeRecipient,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) external {
        super._initialize(
            _defaultAdmin,
            _nodeOperatorManager,
            _nodeOperatorFeeRecipient,
            _nodeOperatorFeeBP,
            _confirmExpiry
        );

        // reduces gas cost for `mintWsteth`
        // invariant: dashboard does not hold stETH on its balance
        STETH.approve(address(WSTETH), type(uint256).max);
    }

    // ==================== View Functions ====================

    /**
     * @notice Returns the vault connection data for the staking vault.
     * @return VaultConnection struct containing vault data
     */
    function vaultConnection() public view returns (VaultHub.VaultConnection memory) {
        return VAULT_HUB.vaultConnection(address(_stakingVault()));
    }

    /**
     * @notice Returns the number of stETH shares minted
     */
    function liabilityShares() public view returns (uint256) {
        return VAULT_HUB.liabilityShares(address(_stakingVault()));
    }

    /**
     * @notice Returns the total value of the vault in ether.
     */
    function totalValue() external view returns (uint256) {
        return VAULT_HUB.totalValue(address(_stakingVault()));
    }

    /**
     * @notice Returns the locked amount of ether for the vault
     */
    function locked() external view returns (uint256) {
        return VAULT_HUB.locked(address(_stakingVault()));
    }

    /**
     * @notice Returns the amount of shares to burn to restore vault healthiness or to cover redemptions and the
     *         amount of outstanding Lido fees
     * @return sharesToBurn amount of shares to burn or to rebalance
     * @return feesToSettle amount of Lido fees to be settled
     */
    function obligations() external view returns (uint256 sharesToBurn, uint256 feesToSettle) {
        (sharesToBurn, feesToSettle) = VAULT_HUB.obligations(address(_stakingVault()));
    }

    /**
     * @notice Returns the amount of shares to rebalance to restore vault healthiness or to cover redemptions
     * @dev returns UINT256_MAX if it's impossible to make the vault healthy using rebalance
     */
    function healthShortfallShares() external view returns (uint256) {
        return VAULT_HUB.healthShortfallShares(address(_stakingVault()));
    }

    /**
     * @notice Returns the amount of ether required to cover obligations shortfall of the vault
     * @dev returns UINT256_MAX if it's impossible to cover obligations shortfall
     * @dev NB: obligationsShortfallValue includes healthShortfallShares converted to ether and any unsettled Lido fees
     *          in case they are greater than the minimum beacon deposit
     */
    function obligationsShortfallValue() external view returns (uint256) {
        return VAULT_HUB.obligationsShortfallValue(address(_stakingVault()));
    }

    /**
     * @notice Returns the amount of ether that is locked on the vault only as a reserve.
     * @dev There is no way to mint stETH for it (it includes connection deposit and slashing reserve)
     */
    function minimalReserve() public view returns (uint256) {
        return VAULT_HUB.vaultRecord(address(_stakingVault())).minimalReserve;
    }

    /**
     * @notice Returns the max total lockable amount of ether for the vault (excluding the Lido and node operator fees)
     */
    function maxLockableValue() external view returns (uint256) {
        uint256 maxLockableValue_ = VAULT_HUB.maxLockableValue(address(_stakingVault()));
        uint256 nodeOperatorFee = accruedFee();

        return maxLockableValue_ > nodeOperatorFee ? maxLockableValue_ - nodeOperatorFee : 0;
    }

    /**
     * @notice Returns the overall capacity for stETH shares that can be minted by the vault
     */
    function totalMintingCapacityShares() external view returns (uint256) {
        return _totalMintingCapacityShares(-int256(accruedFee()));
    }

    /**
     * @notice Returns the remaining capacity for stETH shares that can be minted
     *         by the vault if additional ether is funded
     * @param _etherToFund the amount of ether to be funded, can be zero
     * @return the number of shares that can be minted using additional ether
     */
    function remainingMintingCapacityShares(uint256 _etherToFund) public view returns (uint256) {
        int256 deltaValue = int256(_etherToFund) - int256(accruedFee());
        uint256 vaultTotalMintingCapacityShares = _totalMintingCapacityShares(deltaValue);
        uint256 vaultLiabilityShares = liabilityShares();

        if (vaultTotalMintingCapacityShares <= vaultLiabilityShares) return 0;

        return vaultTotalMintingCapacityShares - vaultLiabilityShares;
    }

    /**
     * @notice Returns the amount of ether that can be instantly withdrawn from the staking vault.
     * @dev This is the amount of ether that is not locked in the StakingVault and not reserved for fees and obligations.
     */
    function withdrawableValue() public view returns (uint256) {
        uint256 withdrawable = VAULT_HUB.withdrawableValue(address(_stakingVault()));
        uint256 nodeOperatorFee = accruedFee();

        return withdrawable > nodeOperatorFee ? withdrawable - nodeOperatorFee : 0;
    }

    // ==================== Vault Management Functions ====================

    /**
     * @dev Automatically funds the staking vault with ether
     */
    receive() external payable {
        if (_shouldFundOnReceive()) _fund(msg.value);
    }

    /**
     * @notice Transfers the ownership of the underlying StakingVault from this contract to a new owner
     *         without disconnecting it from the hub
     * @param _newOwner Address of the new owner.
     * @return bool True if the ownership transfer was executed, false if pending for confirmation
     * @dev after invoking this method node operator fee accrual is effectively disabled
     *      to reenable it (after disconnect fail or reconnect) the related parties must agree on `settledGrowth`
     *      using `correctSettledGrowth()` method
     */
    function transferVaultOwnership(address _newOwner) external returns (bool) {
        if (_newOwner == address(this)) revert DashboardNotAllowed();
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        disburseFee();
        _stopFeeAccrual();

        VAULT_HUB.transferVaultOwnership(address(_stakingVault()), _newOwner);
        return true;
    }

    /**
     * @notice Initiates the disconnection of the underlying StakingVault from the hub and passing its ownership
     *         to Dashboard contract. Disconnection is finalized by applying the next oracle report for this vault,
     *         after which one can call reconnectToVaultHub() to reconnect the vault
     *         or abandonDashboard() to transfer the ownership further to a new owner.
     * @dev reverts if there is not enough ether on the vault balance to pay the accrued node operator fees
     * @dev node operator fees accrued on the moment of disconnection are collected to Dashboard address as `feeLeftover`
     *      and can be recovered later to the fee recipient address
     * @dev after invoking this method node operator fee accrual is effectively disabled
     *      to reenable it (after disconnect fail or reconnect) the related parties must agree on `settledGrowth`
     *      using `correctSettledGrowth()` method
     */
    function voluntaryDisconnect() external {
        // fee are not disbursed to the feeRecipient address to avoid reverts blocking the disconnection
        _collectFeeLeftover();
        _stopFeeAccrual();

        _voluntaryDisconnect();
    }

    /**
     * @notice Recovers the previously collected fees to the feeRecipient address
     */
    function recoverFeeLeftover() external {
        uint256 feeToTransfer = feeLeftover;
        feeLeftover = 0;

        RecoverTokens._recoverEth(feeRecipient, feeToTransfer);
    }

    /**
     * @notice Accepts the ownership over the disconnected StakingVault transferred from VaultHub
     *         and immediately passes it to a new pending owner. This new owner will have to accept the ownership
     *         on the StakingVault contract.
     * @param _newOwner The address to transfer the StakingVault ownership to.
     */
    function abandonDashboard(address _newOwner) external {
        if (VAULT_HUB.isVaultConnected(address(_stakingVault()))) revert ConnectedToVaultHub();
        if (_newOwner == address(this)) revert DashboardNotAllowed();

        _acceptOwnership();
        _transferOwnership(_newOwner);
    }

    /**
     * @notice Accepts the ownership over the StakingVault and connects to VaultHub. Can be called to reconnect
     *         to the hub after voluntaryDisconnect()
     * @dev reverts if settledGrowth is not corrected after the vault is disconnected
     */
    function reconnectToVaultHub() external {
        _acceptOwnership();
        connectToVaultHub();
    }

    /**
     * @notice Connects to VaultHub, transferring underlying StakingVault ownership to VaultHub.
     * @dev reverts if settledGrowth is not corrected after the vault is disconnected
     */
    function connectToVaultHub() public payable {
        if (settledGrowth >= MAX_SANE_SETTLED_GROWTH && feeRate != 0) {
            revert SettleGrowthIsNotSet();
        }

        if (msg.value > 0) _stakingVault().fund{value: msg.value}();
        _transferOwnership(address(VAULT_HUB));
        VAULT_HUB.connectVault(address(_stakingVault()));
    }

    /**
     * @notice Changes the tier of the vault and connects to VaultHub
     * @param _tierId The tier to change to
     * @param _requestedShareLimit The requested share limit
     * @dev reverts if settledGrowth is not corrected after the vault is disconnected
     */
    function connectAndAcceptTier(uint256 _tierId, uint256 _requestedShareLimit) external payable {
        connectToVaultHub();
        if (!_changeTier(_tierId, _requestedShareLimit)) {
            revert TierChangeNotConfirmed();
        }
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
        uint256 withdrawableEther = withdrawableValue();
        if (_ether > withdrawableEther) {
            revert ExceedsWithdrawable(_ether, withdrawableEther);
        }

        _withdraw(_recipient, _ether);
    }

    /**
     * @notice Mints stETH shares backed by the vault to the recipient.
     * @param _recipient Address of the recipient
     * @param _amountOfShares Amount of stETH shares to mint
     */
    function mintShares(address _recipient, uint256 _amountOfShares) external payable fundable {
        _mintSharesWithinMintingCapacity(_recipient, _amountOfShares);
    }

    /**
     * @notice Mints stETH tokens backed by the vault to the recipient.
     * !NB: this will revert with `ZeroArgument()` if the amount of stETH is less than 1 share
     * @param _recipient Address of the recipient
     * @param _amountOfStETH Amount of stETH to mint
     */
    function mintStETH(address _recipient, uint256 _amountOfStETH) external payable fundable {
        _mintSharesWithinMintingCapacity(_recipient, _getSharesByPooledEth(_amountOfStETH));
    }

    /**
     * @notice Mints wstETH tokens backed by the vault to a recipient.
     * @param _recipient Address of the recipient
     * @param _amountOfWstETH Amount of tokens to mint
     */
    function mintWstETH(address _recipient, uint256 _amountOfWstETH) external payable fundable {
        _mintSharesWithinMintingCapacity(address(this), _amountOfWstETH);

        uint256 mintedStETH = STETH.getPooledEthBySharesRoundUp(_amountOfWstETH);

        uint256 wrappedWstETH = WSTETH.wrap(mintedStETH);
        SafeERC20.safeTransfer(WSTETH, _recipient, wrappedWstETH);
    }

    /**
     * @notice Burns stETH shares from the sender backed by the vault.
     *         Expects corresponding amount of stETH approved to this contract.
     * @param _amountOfShares Amount of stETH shares to burn
     */
    function burnShares(uint256 _amountOfShares) external {
        STETH.transferSharesFrom(msg.sender, address(VAULT_HUB), _amountOfShares);
        _burnShares(_amountOfShares);
    }

    /**
     * @notice Burns stETH tokens from the sender backed by the vault. Expects stETH amount approved to this contract.
     * !NB: this will revert with `ZeroArgument()` if the amount of stETH is less than 1 share
     * @param _amountOfStETH Amount of stETH tokens to burn
     */
    function burnStETH(uint256 _amountOfStETH) external {
        _burnStETH(_amountOfStETH);
    }

    /**
     * @notice Burns wstETH tokens from the sender backed by the vault. Expects wstETH amount approved to this contract.
     * @dev !NB: this will revert with `ZeroArgument()` on 1 wei of wstETH due to rounding inside wstETH unwrap method
     * @param _amountOfWstETH Amount of wstETH tokens to burn
     */
    function burnWstETH(uint256 _amountOfWstETH) external {
        _burnWstETH(_amountOfWstETH);
    }

    /**
     * @notice Rebalances the vault's position by transferring ether corresponding to the passed `_shares`
     *         number to Lido Core and writing it off from the vault's liability.
     * @param _shares amount of shares to rebalance
     */
    function rebalanceVaultWithShares(uint256 _shares) external {
        _rebalanceVault(_shares);
    }

    /**
     * @notice Rebalances the vault by transferring ether and writing off the respective shares amount fro the vault's
     *         liability
     * @param _ether amount of ether to rebalance
     * @dev the amount of ether transferred can differ a bit because of the rounding
     */
    function rebalanceVaultWithEther(uint256 _ether) external payable fundable {
        _rebalanceVault(_getSharesByPooledEth(_ether));
    }

    /**
     * @notice Changes the PDG policy. PDGPolicy regulates the possibility of deposits without PredepositGuarantee
     * @param _pdgPolicy new PDG policy
     */
    function setPDGPolicy(PDGPolicy _pdgPolicy) external onlyRoleMemberOrAdmin(DEFAULT_ADMIN_ROLE) {
        if (_pdgPolicy == pdgPolicy) revert PDGPolicyAlreadyActive();

        pdgPolicy = _pdgPolicy;

        emit PDGPolicyEnacted(_pdgPolicy);
    }

    /**
     * @notice Withdraws ether from vault and deposits directly to provided validators bypassing the default PDG process,
     *         allowing validators to be proven post-factum via `proveUnknownValidatorsToPDG` clearing them for future
     *         deposits via `PDG.topUpValidators`. Requires the node operator and vault owner have mutual trust.
     * @param _deposits array of IStakingVault.Deposit structs containing deposit data
     * @return totalAmount total amount of ether deposited to beacon chain
     * @dev requires the PDG policy set to `ALLOW_DEPOSIT_AND_PROVE`
     * @dev requires the caller to have the `NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE`
     * @dev Warning! vulnerable to deposit frontrunning and requires putting trust on the node operator
     * @dev Warning! Prevents node operator fee disbursement till the moment the deposited amount is reported as the part
     *      of the vault total value (depends on the length of the Ethereum entrance queue). Fee may never be disbursed
     *      if the vault is disconnected before the deposit arrives. Recommended to disburse all available fees
     *      before depositing via this method.
     */
    function unguaranteedDepositToBeaconChain(
        IStakingVault.Deposit[] calldata _deposits
    ) external returns (uint256 totalAmount) {
        if (pdgPolicy != PDGPolicy.ALLOW_DEPOSIT_AND_PROVE) revert ForbiddenByPDGPolicy();

        IStakingVault stakingVault_ = _stakingVault();
        IDepositContract depositContract = stakingVault_.DEPOSIT_CONTRACT();

        for (uint256 i = 0; i < _deposits.length; i++) {
            totalAmount += _deposits[i].amount;
        }

        uint256 withdrawableEther = withdrawableValue();
        if (totalAmount > withdrawableEther) {
            revert ExceedsWithdrawable(totalAmount, withdrawableEther);
        }

        _disableFundOnReceive();
        _withdrawForUnguaranteedDepositToBeaconChain(totalAmount);
        // Instead of relying on auto-reset at the end of the transaction,
        // re-enable fund-on-receive manually to restore the default receive() behavior in the same transaction
        _enableFundOnReceive();
        _addFeeExemption(totalAmount);

        bytes memory withdrawalCredentials = bytes.concat(stakingVault_.withdrawalCredentials());

        IStakingVault.Deposit calldata deposit;
        for (uint256 i = 0; i < _deposits.length; i++) {
            deposit = _deposits[i];
            depositContract.deposit{value: deposit.amount}(
                deposit.pubkey,
                withdrawalCredentials,
                deposit.signature,
                deposit.depositDataRoot
            );
        }

        emit UnguaranteedDeposits(address(stakingVault_), _deposits.length, totalAmount);
    }

    /**
     * @notice Proves validators with correct vault WC if they are unknown to PDG
     * @param _witnesses array of IPredepositGuarantee.ValidatorWitness structs containing proof data for validators
     * @dev requires the PDG policy set to `ALLOW_PROVE` or `ALLOW_DEPOSIT_AND_PROVE`
     * @dev requires the caller to have the `NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE`
     */
    function proveUnknownValidatorsToPDG(IPredepositGuarantee.ValidatorWitness[] calldata _witnesses) external {
        if (pdgPolicy == PDGPolicy.STRICT) revert ForbiddenByPDGPolicy();

        _proveUnknownValidatorsToPDG(_witnesses);
    }

    /**
     * @notice Recovers ERC20 tokens or ether from the dashboard contract to the recipient
     * @param _token Address of the token to recover or 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee for ether (EIP-7528)
     * @param _recipient Address of the recovery recipient
     * @param _amount Amount of tokens or ether to recover
     */
    function recoverERC20(
        address _token,
        address _recipient,
        uint256 _amount
    ) external onlyRoleMemberOrAdmin(DEFAULT_ADMIN_ROLE) {
        _requireNotZero(_token);
        _requireNotZero(_recipient);
        _requireNotZero(_amount);

        if (_token == RecoverTokens.ETH) {
            if (_amount > address(this).balance - feeLeftover) revert InsufficientBalance();
            RecoverTokens._recoverEth(_recipient, _amount);
        } else {
            RecoverTokens._recoverERC20(_token, _recipient, _amount);
        }
    }

    /**
     * @notice Collects ERC20 tokens from vault contract balance to the recipient
     * @param _token Address of the token to collect
     * @param _recipient Address of the recipient
     * @param _amount Amount of tokens to collect
     * @dev will revert on EIP-7528 ETH address with EthCollectionNotAllowed() or on zero arguments with ZeroArgument()
     */
    function collectERC20FromVault(
        address _token,
        address _recipient,
        uint256 _amount
    ) external onlyRoleMemberOrAdmin(COLLECT_VAULT_ERC20_ROLE) {
        VAULT_HUB.collectERC20FromVault(address(_stakingVault()), _token, _recipient, _amount);
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
     *         Both partial withdrawals (disabled for if vault is unhealthy) and full validator exits are supported.
     * @param _pubkeys Concatenated validator public keys (48 bytes each).
     * @param _amountsInGwei Withdrawal amounts in Gwei for each validator key. Must match _pubkeys length.
     *         Set amount to 0 for a full validator exit. For partial withdrawals, amounts may be trimmed to keep
     *         MIN_ACTIVATION_BALANCE on the validator to avoid deactivation.
     * @param _refundRecipient Address to receive any fee refunds
     * @dev    A withdrawal fee must be paid via msg.value.
     *         You can use `StakingVault.calculateValidatorWithdrawalFee()` to calculate the approximate fee amount but
     *         it's accurate only for the current block. The fee may change when the tx is included, so it's recommended
     *         to send some surplus. The exact amount required will be paid and the excess will be refunded to the
     *         `_refundRecipient` address. The fee required can grow exponentially, so limit msg.value wisely to avoid
     *         overspending.
     */
    function triggerValidatorWithdrawals(
        bytes calldata _pubkeys,
        uint64[] calldata _amountsInGwei,
        address _refundRecipient
    ) external payable {
        _triggerValidatorWithdrawals(_pubkeys, _amountsInGwei, _refundRecipient);
    }

    /**
     * @notice Requests a change of tier on the OperatorGrid.
     * @param _tierId The tier to change to.
     * @param _requestedShareLimit The requested share limit.
     * @return bool True if the tier change was executed, false if pending for confirmation.
     * @dev Tier change confirmation logic:
     *      - Both vault owner (via this function) AND node operator (via OperatorGrid) confirmations are always required
     *      - First call returns false (pending), second call with both confirmations completes the tier change
     *      - Confirmations expire after the configured period (default: 1 day)
     */
    function changeTier(uint256 _tierId, uint256 _requestedShareLimit) external returns (bool) {
        return _changeTier(_tierId, _requestedShareLimit);
    }

    /**
     * @notice Requests a sync of tier on the OperatorGrid.
     * @return bool True if the tier sync was executed, false if pending for confirmation.
     * @dev Tier sync confirmation logic:
     *      - Both vault owner (via this function) AND node operator (via OperatorGrid) confirmations are required
     *      - First call returns false (pending), second call with both confirmations completes the operation
     *      - Confirmations expire after the configured period (default: 1 day)
     */
    function syncTier() external returns (bool) {
        return _syncTier();
    }

    /**
     * @notice Requests a change of share limit on the OperatorGrid.
     * @param _requestedShareLimit The requested share limit.
     * @return bool True if the share limit change was executed, false if pending for confirmation.
     * @dev Share limit update confirmation logic:
     *      - Both vault owner (via this function) AND node operator (via OperatorGrid) confirmations required
     *      - First call returns false (pending), second call with node operator confirmation completes the operation
     *      - Confirmations expire after the configured period (default: 1 day)
     */
    function updateShareLimit(uint256 _requestedShareLimit) external returns (bool) {
        return _updateVaultShareLimit(_requestedShareLimit);
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
     * @notice Mints shares within the mintable capacity,
     *         and reverts if the resulting backing is greater than the mintable capacity.
     * @param _recipient The address of the recipient.
     * @param _amountOfShares The amount of shares to mint.
     */
    function _mintSharesWithinMintingCapacity(address _recipient, uint256 _amountOfShares) internal {
        uint256 remainingShares = remainingMintingCapacityShares(0);
        if (_amountOfShares > remainingShares) revert ExceedsMintingCapacity(_amountOfShares, remainingShares);

        _mintShares(_recipient, _amountOfShares);
    }

    /**
     * @dev Burns stETH tokens from the sender backed by the vault
     * @param _amountOfStETH Amount of tokens to burn
     */
    function _burnStETH(uint256 _amountOfStETH) internal {
        uint256 _amountOfShares = _getSharesByPooledEth(_amountOfStETH);
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
        uint256 unwrappedShares = _getSharesByPooledEth(unwrappedStETH);

        STETH.transferShares(address(VAULT_HUB), unwrappedShares);
        _burnShares(unwrappedShares);
    }

    /// @notice Calculates the total number of shares that is possible to mint on the vault
    /// @dev the delta value is the amount of ether to add or subtract from the total value of the vault
    function _totalMintingCapacityShares(int256 _deltaValue) internal view returns (uint256) {
        return VAULT_HUB.totalMintingCapacityShares(address(_stakingVault()), _deltaValue);
    }

    /// @notice Converts the given amount of stETH to shares
    function _getSharesByPooledEth(uint256 _amountOfStETH) internal view returns (uint256) {
        return STETH.getSharesByPooledEth(_amountOfStETH);
    }

    // @dev The logic is inverted, 0 means fund-on-receive is enabled,
    // so that fund-on-receive is enabled by default
    function _shouldFundOnReceive() internal view returns (bool shouldFund) {
        assembly {
            shouldFund := iszero(tload(FUND_ON_RECEIVE_FLAG_SLOT))
        }
    }

    function _enableFundOnReceive() internal {
        assembly {
            tstore(FUND_ON_RECEIVE_FLAG_SLOT, 0)
        }
    }

    function _disableFundOnReceive() internal {
        assembly {
            tstore(FUND_ON_RECEIVE_FLAG_SLOT, 1)
        }
    }

    /**
     * @dev Withdraws ether from vault to this contract for unguaranteed deposit to validators
     * Requires the caller to have the `NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE`.
     */
    function _withdrawForUnguaranteedDepositToBeaconChain(
        uint256 _ether
    ) internal onlyRoleMemberOrAdmin(NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE) {
        VAULT_HUB.withdraw(address(_stakingVault()), address(this), _ether);
    }

    /**
     * @dev Proves validators unknown to PDG that have correct vault WC
     * Requires the caller to have the `NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE`.
     */
    function _proveUnknownValidatorsToPDG(
        IPredepositGuarantee.ValidatorWitness[] calldata _witnesses
    ) internal onlyRoleMemberOrAdmin(NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE) {
        for (uint256 i = 0; i < _witnesses.length; i++) {
            VAULT_HUB.proveUnknownValidatorToPDG(address(_stakingVault()), _witnesses[i]);
        }
    }

    function _collectFeeLeftover() internal {
        (uint256 fee, int256 growth, uint256 abnormallyHighFeeThreshold) = _calculateFee();
        if (fee > abnormallyHighFeeThreshold) revert AbnormallyHighFee();

        if (fee > 0) {
            feeLeftover += uint128(fee);

            _disableFundOnReceive();
            _disburseFee(fee, growth, address(this));
            _enableFundOnReceive();
        }
    }

    // ==================== Events ====================

    /**
     * @notice Emitted when ether was withdrawn from the staking vault and deposited to validators directly bypassing PDG
     * @param stakingVault the address of owned staking vault
     * @param deposits the number of deposits
     * @param totalAmount the total amount of ether deposited to beacon chain
     */
    event UnguaranteedDeposits(address indexed stakingVault, uint256 deposits, uint256 totalAmount);

    /**
     * @notice Emitted when the PDG policy is updated.
     */
    event PDGPolicyEnacted(PDGPolicy pdgPolicy);

    // ==================== Errors ====================

    /**
     * @notice Emitted when the withdrawable amount of ether is exceeded
     * @param amount The amount of ether that was attempted to be withdrawn
     * @param withdrawableValue The amount of withdrawable ether available
     */
    error ExceedsWithdrawable(uint256 amount, uint256 withdrawableValue);

    /**
     * @notice Error thrown when minting capacity is exceeded
     */
    error ExceedsMintingCapacity(uint256 requestedShares, uint256 remainingShares);

    /**
     * @notice Error when the StakingVault is still connected to the VaultHub.
     */
    error ConnectedToVaultHub();

    /**
     * @notice Error thrown when attempting to connect to VaultHub without confirmed tier change
     */
    error TierChangeNotConfirmed();

    /**
     * @notice Error when attempting to abandon the Dashboard contract itself.
     */
    error DashboardNotAllowed();

    /**
     * @notice Error when attempting to set the same PDG policy that is already active.
     */
    error PDGPolicyAlreadyActive();

    /**
     * @notice Error when attempting to perform an operation that is not allowed
     * by the current active PDG policy.
     */
    error ForbiddenByPDGPolicy();

    error InsufficientBalance();

    /**
     * @dev Error emitted when connection is reverted because node operator's fee is stopped
     */
    error SettleGrowthIsNotSet();
}
