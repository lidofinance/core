// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {PausableUntil} from "./utils/PausableUntil.sol";
import {IBurner} from "../common/interfaces/IBurner.sol";

interface ILidoForRedeemsReserve {
    function getSharesByPooledEth(uint256 _pooledEthAmount) external view returns (uint256);
    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256);
    function transferSharesFrom(address _sender, address _recipient, uint256 _sharesAmount) external returns (uint256);
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
 *   On each oracle report, Lido pushes ETH here to match the reserve target
 *   or pulls excess back. Between reports, anyone can call `redeem()` to exchange
 *   stETH for ETH. The stETH is routed to the Burner for deferred burning on the
 *   next oracle report.
 *
 *   Gate Seal compatible via PausableUntil — the vault can be frozen without stopping Lido.
 */
contract RedeemsReserveVault is PausableUntil, AccessControlEnumerable {
    /// @notice Role for pausing the contract
    bytes32 public constant PAUSE_ROLE = keccak256("RedeemsReserveVault.PauseRole");
    /// @notice Role for resuming the contract
    bytes32 public constant RESUME_ROLE = keccak256("RedeemsReserveVault.ResumeRole");

    ILidoForRedeemsReserve public immutable LIDO;
    IBurner public immutable BURNER;
    IWithdrawalQueueForRedeemsReserve public immutable WITHDRAWAL_QUEUE;

    event Redeemed(
        address indexed caller,
        address indexed ethRecipient,
        uint256 stETHAmount,
        uint256 sharesAmount,
        uint256 etherAmount
    );

    error ZeroAmount();
    error ZeroRecipient();
    error LidoStopped();
    error BunkerMode();
    error WQPaused();
    error InsufficientReserve(uint256 requested, uint256 available);
    error NotLido();
    error InsufficientBalance(uint256 requested, uint256 available);
    error ETHTransferFailed(address recipient, uint256 amount);

    constructor(
        address _lido,
        address _burner,
        address _withdrawalQueue,
        address _admin
    ) {
        LIDO = ILidoForRedeemsReserve(_lido);
        BURNER = IBurner(_burner);
        WITHDRAWAL_QUEUE = IWithdrawalQueueForRedeemsReserve(_withdrawalQueue);

        // Approve Burner to transfer vault's stETH (needed for requestBurnShares → transferSharesFrom)
        LIDO.approve(_burner, type(uint256).max);

        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /**
     * @notice Redeem stETH for ETH from the reserve.
     *         Transfers stETH shares from caller to Burner (deferred burn),
     *         sends equivalent ETH to recipient.
     * @param _stETHAmount Amount of stETH to redeem
     * @param _ethRecipient Address to receive ETH
     */
    function redeem(uint256 _stETHAmount, address _ethRecipient) external whenResumed {
        if (_stETHAmount == 0) revert ZeroAmount();
        if (_ethRecipient == address(0)) revert ZeroRecipient();
        if (LIDO.isStopped()) revert LidoStopped();
        if (WITHDRAWAL_QUEUE.isBunkerModeActive()) revert BunkerMode();
        if (WITHDRAWAL_QUEUE.isPaused()) revert WQPaused();

        uint256 sharesAmount = LIDO.getSharesByPooledEth(_stETHAmount);
        uint256 etherAmount = LIDO.getPooledEthByShares(sharesAmount);

        if (address(this).balance < etherAmount) {
            revert InsufficientReserve(etherAmount, address(this).balance);
        }

        // Pull stETH shares from caller, route to Burner for deferred burn
        LIDO.transferSharesFrom(msg.sender, address(this), sharesAmount);
        BURNER.requestBurnShares(address(this), sharesAmount);

        // Push ETH to recipient
        (bool success,) = _ethRecipient.call{value: etherAmount}("");
        if (!success) revert ETHTransferFailed(_ethRecipient, etherAmount);

        emit Redeemed(msg.sender, _ethRecipient, _stETHAmount, sharesAmount, etherAmount);
    }

    /**
     * @notice Check if a redemption of the given stETH amount would succeed.
     * @param _stETHAmount Amount of stETH to check
     * @return true if all redemption conditions are met
     */
    function canRedeem(uint256 _stETHAmount) external view returns (bool) {
        if (_stETHAmount == 0) return false;
        if (isPaused()) return false;
        if (LIDO.isStopped()) return false;
        if (WITHDRAWAL_QUEUE.isBunkerModeActive()) return false;
        if (WITHDRAWAL_QUEUE.isPaused()) return false;

        uint256 sharesAmount = LIDO.getSharesByPooledEth(_stETHAmount);
        uint256 etherAmount = LIDO.getPooledEthByShares(sharesAmount);
        return address(this).balance >= etherAmount;
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
        LIDO.receiveRedeemsReserve{value: _amount}();
    }

    /**
     * @notice Pause redemptions for a duration.
     * @param _duration Duration in seconds
     */
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /**
     * @notice Pause redemptions until a timestamp.
     * @param _pauseUntilInclusive Timestamp until which to pause
     */
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /**
     * @notice Resume redemptions.
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Accept ETH from Lido (reserve top-up on report).
     */
    receive() external payable {
        if (msg.sender != address(LIDO)) revert NotLido();
    }
}
