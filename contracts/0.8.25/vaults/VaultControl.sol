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

contract VaultControl is VaultHub {
    IDepositContract public immutable DEPOSIT_CONTRACT;

    constructor(
        ILidoLocator _locator,
        ILido _lido,
        uint256 _relativeShareLimitBP,
        IDepositContract _depositContract
    ) VaultHub(_locator, _lido, _relativeShareLimitBP) {
        if (address(_depositContract) == address(0)) revert ZeroArgument("_depositContract");

        DEPOSIT_CONTRACT = _depositContract;
    }

    function unlocked(address _vault) public view returns (uint256) {
        uint256 totalValue_ = totalValue(_vault);
        uint256 locked_ = _socket(_vault).locked;

        if (locked_ > totalValue_) return 0;

        return totalValue_ - locked_;
    }

    function latestReport(address _vault) public view returns (VaultHub.Report memory) {
        return _socket(_vault).report;
    }

    function fund(address _vault) external payable {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();

        _socket(_vault).inOutDelta += int128(int256(msg.value));

        (bool success, ) = _vault.call{value: msg.value}("");
        if (!success) revert TransferFailed(_vault, msg.value);

        emit VaultFunded(_vault, msg.sender, msg.value);
    }

    function withdraw(address _vault, address _recipient, uint256 _ether) external {
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();

        uint256 unlocked_ = unlocked(_vault);
        if (_ether > unlocked_) revert InsufficientUnlocked(unlocked_);

        _withdrawFromVault(_vault, _recipient, _ether);

        uint256 totalValueAfterWithdraw = totalValue(_vault);

        if (isReportFresh(_vault)) {
            if (totalValueAfterWithdraw < _socket(_vault).locked) revert TotalValueBelowLockedAmount();
        } else {
            if (_vault.balance < _socket(_vault).locked) revert TotalValueBelowLockedAmount();
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

    function depositToBeaconChain(address _vault, StakingVaultDeposit[] calldata _deposits) external {
        if (_deposits.length == 0) revert ZeroArgument("_deposits");

        VaultSocket storage socket = _socket(_vault);
        if (socket.depositsPaused) revert BeaconChainDepositsArePaused();
        if (msg.sender != LIDO_LOCATOR.predepositGuarantee()) revert NotAuthorized();
        if (totalValue(_vault) < socket.locked) revert TotalValueBelowLockedAmount();

        uint256 numberOfDeposits = _deposits.length;

        uint256 totalAmount;
        for (uint256 i = 0; i < numberOfDeposits; i++) {
            totalAmount += _deposits[i].amount;
        }
        if (totalAmount > _vault.balance) revert InsufficientBalance(_vault.balance);
        _withdrawFromVault(_vault, address(this), totalAmount);

        bytes memory withdrawalCredentials_ = bytes.concat(IStakingVault(_vault).withdrawalCredentials());

        for (uint256 i = 0; i < numberOfDeposits; i++) {
            StakingVaultDeposit calldata deposit = _deposits[i];

            DEPOSIT_CONTRACT.deposit{value: deposit.amount}(
                deposit.pubkey,
                withdrawalCredentials_,
                deposit.signature,
                deposit.depositDataRoot
            );
        }

        emit DepositedToBeaconChain(msg.sender, numberOfDeposits, totalAmount);
    }

    function triggerValidatorWithdrawal(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        VaultSocket storage socket = _socket(_vault);
        if (totalValue(_vault) < socket.locked) revert TotalValueBelowLockedAmount();

        if (msg.sender != socket.manager && msg.sender != socket.operator) revert NotAuthorized();

        IStakingVault(_vault).triggerValidatorWithdrawal{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    function _rebalance(address _vault, uint256 _ether) internal {
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > _vault.balance) revert InsufficientBalance(_vault.balance);

        uint256 totalValue_ = totalValue(_vault);
        if (_ether > totalValue_) revert RebalanceAmountExceedsTotalValue(totalValue_, _ether);

        VaultSocket storage socket = _socket(_vault);

        uint256 sharesToBurn = LIDO.getSharesByPooledEth(_ether);
        uint256 liabilityShares = socket.liabilityShares;
        if (liabilityShares < sharesToBurn) revert InsufficientSharesToBurn(msg.sender, liabilityShares);
        socket.liabilityShares = uint96(liabilityShares - sharesToBurn);

        _withdrawFromVault(_vault, address(this), _ether);

        LIDO.rebalanceExternalEtherToInternal{value: _ether}();
        emit VaultRebalanced(msg.sender, sharesToBurn);
    }

    function _withdrawFromVault(address _vault, address _recipient, uint256 _amount) internal {
        _socket(_vault).inOutDelta -= int128(int256(_amount));
        IStakingVault(_vault).withdraw(_recipient, _amount);
        emit VaultWithdrawn(_vault, msg.sender, _recipient, _amount);
    }

    /**
     * @notice Emitted when `StakingVault` is funded with ether
     * @dev Event is not emitted upon direct transfers through `receive()`
     * @param sender Address that funded the vault
     * @param amount Amount of ether funded
     */
    event VaultFunded(address indexed vault, address indexed sender, uint256 amount);

    /**
     * @notice Emitted when ether is withdrawn from `StakingVault`
     * @dev Also emitted upon rebalancing in favor of `VaultHub`
     * @param sender Address that initiated the withdrawal
     * @param recipient Address that received the withdrawn ether
     * @param amount Amount of ether withdrawn
     */
    event VaultWithdrawn(address indexed vault, address indexed sender, address indexed recipient, uint256 amount);

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
     * @notice Thrown when trying to withdraw more ether than the balance of `StakingVault`
     * @param balance Current balance
     */
    error InsufficientBalance(uint256 balance);

    /**
     * @notice Thrown when trying to withdraw more than the unlocked amount
     * @param unlocked Current unlocked amount
     */
    error InsufficientUnlocked(uint256 unlocked);

    /**
     * @notice Thrown when the total value of the vault falls below the locked amount
     */
    error TotalValueBelowLockedAmount();

    /**
     * @notice Thrown when attempting to rebalance more ether than the current total value of the vault
     * @param totalValue Current total value of the vault
     * @param rebalanceAmount Amount attempting to rebalance
     */
    error RebalanceAmountExceedsTotalValue(uint256 totalValue, uint256 rebalanceAmount);

    error BeaconChainDepositsArePaused();
}
