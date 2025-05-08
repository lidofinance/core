// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "../interfaces/ILido.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {StakingVaultDeposit} from "./interfaces/IStakingVault.sol";
import {IDepositContract} from "contracts/0.8.25/interfaces/IDepositContract.sol";
import {OperatorGrid} from "./OperatorGrid.sol";

contract VaultControl is VaultHub {
    constructor(
        ILidoLocator _locator,
        ILido _lido,
        uint256 _relativeShareLimitBP
    ) VaultHub(_locator, _lido, _relativeShareLimitBP) {}

    function unlocked(address _vault) public view returns (uint256) {
        uint256 totalValue_ = totalValue(_vault);
        uint256 locked_ = _connectedSocket(_vault).locked;

        if (locked_ > totalValue_) return 0;

        return totalValue_ - locked_;
    }

    function fund(address _vault) external payable {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();

        _connectedSocket(_vault).inOutDelta += int128(int256(msg.value));

        (bool success, ) = _vault.call{value: msg.value}("");
        if (!success) revert TransferFailed(_vault, msg.value);

        emit VaultFunded(_vault, msg.sender, msg.value);
    }

    function withdraw(address _vault, address _recipient, uint256 _ether) external withAllObligationsSettled(_vault) {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();

        uint256 unlocked_ = unlocked(_vault);
        if (_ether > unlocked_) revert InsufficientUnlocked(unlocked_);

        _withdrawFromVault(_vault, _recipient, _ether);

        uint256 totalValueAfterWithdraw = totalValue(_vault);
        if (isReportFresh(_vault)) {
            if (totalValueAfterWithdraw < _connectedSocket(_vault).locked) revert TotalValueBelowLockedAmount();
        } else {
            if (_vault.balance < _connectedSocket(_vault).locked) revert TotalValueBelowLockedAmount();
        }
    }

    /// @notice permissionless rebalance for unhealthy vaults
    /// @param _vault vault address
    /// @dev rebalance all available amount of ether until the vault is healthy
    function forceRebalance(address _vault) external {
        uint256 fullRebalanceAmount = rebalanceShortfall(_vault);
        if (fullRebalanceAmount == 0) revert AlreadyHealthy(_vault);

        // TODO: add some gas compensation here
        _rebalance(_vault, Math256.min(fullRebalanceAmount, _vault.balance));
    }

    /**
     * @notice Rebalances StakingVault by withdrawing ether to VaultHub
     * @dev Can only be called by VaultHub if StakingVault totalValue is less than locked amount
     * @param _ether Amount of ether to rebalance
     */
    function rebalance(address _vault, uint256 _ether) external {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();

        _rebalance(_vault, _ether);
    }

    /// @notice mint StETH shares backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _amountOfShares amount of stETH shares to mint
    /// @dev msg.sender should be vault's owner
    function mintShares(address _vault, address _recipient, uint256 _amountOfShares) external whenResumed {
        if (_vault == address(0)) revert VaultZeroAddress();
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 vaultSharesAfterMint = socket.liabilityShares + _amountOfShares;
        uint256 shareLimit = socket.shareLimit;
        if (vaultSharesAfterMint > shareLimit) revert ShareLimitExceeded(_vault, shareLimit);

        if (!isReportFresh(_vault)) revert VaultReportStaled(_vault);

        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - socket.reserveRatioBP;
        uint256 maxMintableEther = (totalValue(_vault) * maxMintableRatioBP) / TOTAL_BASIS_POINTS;
        uint256 stETHAfterMint = LIDO.getPooledEthBySharesRoundUp(vaultSharesAfterMint);
        if (stETHAfterMint > maxMintableEther) {
            revert InsufficientTotalValueToMint(_vault, totalValue(_vault));
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 etherToLock = (stETHAfterMint * TOTAL_BASIS_POINTS) / maxMintableRatioBP;

        if (etherToLock > socket.locked) {
            socket.locked = uint128(etherToLock);
        }

        socket.liabilityShares = uint96(vaultSharesAfterMint);
        LIDO.mintExternalShares(_recipient, _amountOfShares);
        OperatorGrid(LIDO_LOCATOR.operatorGrid()).onMintedShares(_vault, _amountOfShares);

        emit MintedSharesOnVault(_vault, _amountOfShares);
    }

    /// @notice burn steth shares from the balance of the VaultHub contract
    /// @param _vault vault address
    /// @param _amountOfShares amount of shares to burn
    /// @dev msg.sender should be vault's owner
    /// @dev VaultHub must have all the stETH on its balance
    function burnShares(address _vault, uint256 _amountOfShares) public whenResumed {
        if (_vault == address(0)) revert VaultZeroAddress();
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 liabilityShares = socket.liabilityShares;
        if (liabilityShares < _amountOfShares) revert InsufficientSharesToBurn(_vault, liabilityShares);

        socket.liabilityShares = uint96(liabilityShares - _amountOfShares);

        LIDO.burnExternalShares(_amountOfShares);
        OperatorGrid(LIDO_LOCATOR.operatorGrid()).onBurnedShares(_vault, _amountOfShares);

        emit BurnedSharesOnVault(_vault, _amountOfShares);
    }

    /// @notice separate burn function for EOA vault owners; requires vaultHub to be approved to transfer stETH
    /// @dev msg.sender should be vault's owner
    function transferAndBurnShares(address _vault, uint256 _amountOfShares) external {
        LIDO.transferSharesFrom(msg.sender, address(this), _amountOfShares);

        burnShares(_vault, _amountOfShares);
    }

    function pauseBeaconChainDeposits(address _vault) external {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();
        IStakingVault(_vault).pauseBeaconChainDeposits();
    }

    function resumeBeaconChainDeposits(address _vault) external {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();
        IStakingVault(_vault).resumeBeaconChainDeposits();
    }

    function depositToBeaconChain(address _vault, StakingVaultDeposit[] calldata _deposits) external withAllObligationsSettled(_vault) {
        if (msg.sender != LIDO_LOCATOR.predepositGuarantee()) revert NotAuthorized();
        VaultSocket storage socket = _connectedSocket(_vault);
        if (totalValue(_vault) < socket.locked) revert TotalValueBelowLockedAmount();

        IStakingVault(_vault).depositToBeaconChain(_deposits);
    }

    function requestValidatorExit(address _vault, bytes calldata _pubkeys) external {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();
        IStakingVault(_vault).requestValidatorExit(_pubkeys);
    }

    function triggerValidatorWithdrawal(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        VaultSocket storage socket = _connectedSocket(_vault);
        bool isAuthorized = _isManager(msg.sender, _vault);
        if (vaultObligationsForCategory(_vault, ObligationCategory.Withdrawals) > 0) {
            isAuthorized = isAuthorized || hasRole(WITHDRAWALS_OBLIGATION_FULFILLER_ROLE, msg.sender);
        }
        if (!isAuthorized) revert NotAuthorized();

        // TODO: this looks suspicious, we can't block exits, but we may want to block partial withdrawals when vault is unhealthy
        if (totalValue(_vault) < socket.locked) revert TotalValueBelowLockedAmount();

        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    /// @notice Forces validator exit from the beacon chain when vault is unhealthy
    /// @param _vault The address of the vault to exit validators from
    /// @param _pubkeys The public keys of the validators to exit
    /// @param _refundRecipient The address that will receive the refund for transaction costs
    /// @dev    When the vault becomes unhealthy, anyone can force its validators to exit the beacon chain
    ///         This returns the vault's deposited ETH back to vault's balance and allows to rebalance the vault
    function forceValidatorExit(address _vault, bytes calldata _pubkeys, address _refundRecipient) external payable {
        if (_vault == address(0)) revert VaultZeroAddress();
        if (isVaultHealthyAsOfLatestReport(_vault)) revert AlreadyHealthy(_vault);

        IStakingVault(_vault).triggerValidatorExits{value: msg.value}(_pubkeys, _refundRecipient);

        emit ForcedValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
    }

    function setManager(address _vault, address _manager) external {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();
        _connectedSocket(_vault).manager = _manager;
    }

    /**
     * @notice Emitted when `StakingVault` is funded with ether
     * @dev Event is not emitted upon direct transfers through `receive()`
     * @param sender Address that funded the vault
     * @param amount Amount of ether funded
     */
    event VaultFunded(address indexed vault, address indexed sender, uint256 amount);

    /**
     * @notice Emitted when the locked amount is increased
     * @param locked New amount of locked ether
     */
    event LockedIncreased(uint256 locked);

    /**
     * @notice Emitted when deposits are paused
     */
    event DepositedToBeaconChain(address indexed sender, uint256 numberOfDeposits, uint256 totalAmount);

    /**
     * @notice Emitted when the manager is set
     * @param vault The address of the vault
     * @param manager The address of the manager
     */
    event ManagerSet(address indexed vault, address indexed manager);

    /**
     * @notice Thrown when attempting to decrease the locked amount outside of a report
     */
    error NewLockedNotGreaterThanCurrent();

    /**
     * @notice Thrown when the locked amount exceeds the total value
     */
    error NewLockedExceedsTotalValue();

    /**
     * @notice Thrown when the transfer of ether to a recipient fails
     * @param recipient Address that was supposed to receive the transfer
     * @param amount Amount that failed to transfer
     */
    error TransferFailed(address recipient, uint256 amount);

    /**
     * @notice Thrown when trying to withdraw more than the unlocked amount
     * @param unlocked Current unlocked amount
     */
    error InsufficientUnlocked(uint256 unlocked);

    /**
     * @notice Thrown when the total value of the vault falls below the locked amount
     */
    error TotalValueBelowLockedAmount();

    error BeaconChainDepositsArePaused();
}
