// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {IERC20} from "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {PausableUntil} from "./utils/PausableUntil.sol";
import {IBurner} from "../common/interfaces/IBurner.sol";

interface ILidoForRedeemsReserve {
    function getSharesByPooledEth(uint256 _pooledEthAmount) external view returns (uint256);
    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256);
    function transferSharesFrom(address _sender, address _recipient, uint256 _sharesAmount) external returns (uint256);
    function transferShares(address _recipient, uint256 _sharesAmount) external returns (uint256);
    function sharesOf(address _account) external view returns (uint256);
    function approve(address _spender, uint256 _amount) external returns (bool);
    function isStopped() external view returns (bool);
    function receiveRedeemsReserve() external payable;
}

interface IWithdrawalQueueForRedeemsReserve {
    function isBunkerModeActive() external view returns (bool);
    function isPaused() external view returns (bool);
}

/**
 * @title RedeemsReserveVault
 * @notice Holds reserve ETH for stETH-to-ETH redemptions.
 *
 *   On each oracle report, Lido funds the vault via `fundReserve()` to match the
 *   reserve target, or pulls excess back via `withdrawToLido()`. Between reports,
 *   REDEEMER_ROLE holders invoke `redeem()` to exchange stETH for ETH. The stETH
 *   shares are held locally and flushed to the Burner during the next oracle report,
 *   where they are burned outside the rebase limiter (rate-neutral).
 *
 *   Gate Seal compatible via PausableUntil.
 */
contract RedeemsReserveVault is PausableUntil, AccessControlEnumerable {
    bytes32 public constant PAUSE_ROLE = keccak256("RedeemsReserveVault.PauseRole");
    bytes32 public constant RESUME_ROLE = keccak256("RedeemsReserveVault.ResumeRole");
    bytes32 public constant REDEEMER_ROLE = keccak256("RedeemsReserveVault.RedeemerRole");

    ILidoForRedeemsReserve public immutable LIDO;
    IBurner public immutable BURNER;
    IWithdrawalQueueForRedeemsReserve public immutable WITHDRAWAL_QUEUE;
    address public immutable ACCOUNTING;

    uint256 private _reserveBalance;
    uint256 private _redeemedShares;
    uint256 private _redeemedEther;

    event Redeemed(
        address indexed caller,
        address indexed ethRecipient,
        uint256 stETHAmount,
        uint256 sharesAmount,
        uint256 etherAmount
    );
    event SharesFlushedToBurner(uint256 sharesAmount);
    event ReserveFunded(uint256 amount);

    error ZeroAmount();
    error ZeroRecipient();
    error LidoStopped();
    error BunkerMode();
    error WQPaused();
    error InsufficientReserve(uint256 requested, uint256 available);
    error NotLido();
    error NotAccounting();
    error InsufficientBalance(uint256 requested, uint256 available);
    error ETHTransferFailed(address recipient, uint256 amount);
    error StETHRecoveryNotAllowed();

    constructor(
        address _lido,
        address _burner,
        address _withdrawalQueue,
        address _accounting,
        address _admin
    ) {
        LIDO = ILidoForRedeemsReserve(_lido);
        BURNER = IBurner(_burner);
        WITHDRAWAL_QUEUE = IWithdrawalQueueForRedeemsReserve(_withdrawalQueue);
        ACCOUNTING = _accounting;

        LIDO.approve(_burner, type(uint256).max);
        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /**
     * @notice Redeem stETH for ETH from the reserve.
     *         Checks against tracked reserve balance (not address(this).balance)
     *         to prevent force-sent ETH from being redeemable.
     * @param _stETHAmount Amount of stETH to redeem
     * @param _ethRecipient Address to receive ETH
     */
    function redeem(uint256 _stETHAmount, address _ethRecipient) external onlyRole(REDEEMER_ROLE) whenResumed {
        if (_stETHAmount == 0) revert ZeroAmount();
        if (_ethRecipient == address(0)) revert ZeroRecipient();
        if (LIDO.isStopped()) revert LidoStopped();
        if (WITHDRAWAL_QUEUE.isBunkerModeActive()) revert BunkerMode();
        if (WITHDRAWAL_QUEUE.isPaused()) revert WQPaused();

        uint256 sharesAmount = LIDO.getSharesByPooledEth(_stETHAmount);
        uint256 etherAmount = LIDO.getPooledEthByShares(sharesAmount);

        uint256 available = _reserveBalance - _redeemedEther;
        if (etherAmount > available) {
            revert InsufficientReserve(etherAmount, available);
        }

        LIDO.transferSharesFrom(msg.sender, address(this), sharesAmount);
        _redeemedShares += sharesAmount;
        _redeemedEther += etherAmount;

        (bool success,) = _ethRecipient.call{value: etherAmount}("");
        if (!success) revert ETHTransferFailed(_ethRecipient, etherAmount);

        emit Redeemed(msg.sender, _ethRecipient, _stETHAmount, sharesAmount, etherAmount);
    }

    /// @notice Shares accumulated from redemptions since the last report.
    function getRedeemedShares() external view returns (uint256) {
        return _redeemedShares;
    }

    /// @notice ETH sent to redeemers since the last report.
    function getRedeemedEther() external view returns (uint256) {
        return _redeemedEther;
    }

    /**
     * @notice Accept ETH from Lido and update tracked reserve balance.
     *         Called by Lido during report to fund the reserve.
     */
    function fundReserve() external payable {
        if (msg.sender != address(LIDO)) revert NotLido();
        _reserveBalance += msg.value;
        emit ReserveFunded(msg.value);
    }

    /**
     * @notice Forwards accumulated shares to Burner for burning.
     *         Called by Accounting during oracle report, before commitSharesToBurn().
     *         Resets shares counter only. Ether counter is reset during reconcile.
     */
    function flushSharesToBurner() external {
        if (msg.sender != ACCOUNTING) revert NotAccounting();
        uint256 shares = _redeemedShares;
        if (shares > 0) {
            BURNER.requestBurnShares(address(this), shares);
            emit SharesFlushedToBurner(shares);
        }
        _redeemedShares = 0;
    }

    /**
     * @notice Resets the redeemed ether counter. Called by Accounting after reconcile.
     */
    function resetRedeemedEther() external {
        if (msg.sender != ACCOUNTING) revert NotAccounting();
        _redeemedEther = 0;
    }

    /**
     * @notice Returns ETH to Lido. Called by Lido when vault has excess over target.
     * @param _amount Amount of ETH to return
     */
    function withdrawToLido(uint256 _amount) external {
        if (msg.sender != address(LIDO)) revert NotLido();
        if (_amount > address(this).balance) {
            revert InsufficientBalance(_amount, address(this).balance);
        }
        _reserveBalance -= _amount;
        LIDO.receiveRedeemsReserve{value: _amount}();
    }

    // ── Recovery ─────────────────────────────────────────────────────────

    /// @notice Recover accidentally sent ERC20 tokens (except stETH).
    function recoverERC20(address _token, uint256 _amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_token == address(LIDO)) revert StETHRecoveryNotAllowed();
        IERC20(_token).transfer(msg.sender, _amount);
    }

    /// @notice Recover excess stETH shares above the redeemed amount.
    function recoverStETHShares() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 sharesOnVault = LIDO.sharesOf(address(this));
        uint256 excess = sharesOnVault - _redeemedShares;
        if (excess > 0) {
            LIDO.transferShares(msg.sender, excess);
        }
    }

    // ── Pause ────────────────────────────────────────────────────────────

    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /// @notice Reject direct ETH transfers. Use fundReserve() instead.
    receive() external payable {
        revert NotLido();
    }
}
