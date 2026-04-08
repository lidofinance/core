// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

import {RefSlotCache} from "./vaults/lib/RefSlotCache.sol";

interface ILidoForRedeemsBuffer {
    function getSharesByPooledEth(uint256 _pooledEthAmount) external view returns (uint256);
    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256);
    function transferSharesFrom(address _sender, address _recipient, uint256 _sharesAmount) external returns (uint256);
    function transferShares(address _recipient, uint256 _sharesAmount) external returns (uint256);
    function sharesOf(address _account) external view returns (uint256);
    function approve(address _spender, uint256 _amount) external returns (bool);
    function isStopped() external view returns (bool);
    function receiveFromRedeemsBuffer() external payable;
}

interface IBurnerForRedeemsBuffer {
    function requestBurnShares(address _from, uint256 _sharesAmountToBurn) external;
}

interface IWithdrawalQueueForRedeemsBuffer {
    function isBunkerModeActive() external view returns (bool);
    function isPaused() external view returns (bool);
}

/**
 * @title RedeemsBuffer
 * @notice Holds reserve ETH for stETH-to-ETH redemptions.
 *
 *   Uses RefSlotCache to snapshot redeem counters at frame boundaries,
 *   so Accounting reads the same values that the oracle daemon sees at refSlot.
 *
 *   Gate Seal compatible via PausableUntil.
 */
contract RedeemsBuffer is PausableUntil, AccessControlEnumerable {
    using RefSlotCache for RefSlotCache.Uint104WithCache;

    bytes32 public constant PAUSE_ROLE = keccak256("RedeemsBuffer.PauseRole");
    bytes32 public constant RESUME_ROLE = keccak256("RedeemsBuffer.ResumeRole");
    bytes32 public constant REDEEMER_ROLE = keccak256("RedeemsBuffer.RedeemerRole");

    ILidoLocator public immutable LOCATOR;
    ILidoForRedeemsBuffer public immutable LIDO;
    IBurnerForRedeemsBuffer public immutable BURNER;
    IWithdrawalQueueForRedeemsBuffer public immutable WITHDRAWAL_QUEUE;
    IHashConsensus public immutable HASH_CONSENSUS;

    uint256 private _reserveBalance;
    RefSlotCache.Uint104WithCache private _redeemedEther;
    RefSlotCache.Uint104WithCache private _redeemedShares;

    event Redeemed(
        address indexed caller,
        address indexed ethRecipient,
        uint256 stETHAmount,
        uint256 sharesAmount,
        uint256 etherAmount
    );
    event ReserveFunded(uint256 amount);

    error ZeroAmount();
    error ZeroRecipient();
    error LidoStopped();
    error BunkerMode();
    error WQPaused();
    error InsufficientReserve(uint256 requested, uint256 available);
    error NotLido();
    error ETHTransferFailed(address recipient, uint256 amount);
    error StETHRecoveryNotAllowed();
    error DirectETHTransferNotAllowed();

    constructor(address _locator, address _hashConsensus) {
        LOCATOR = ILidoLocator(_locator);
        LIDO = ILidoForRedeemsBuffer(LOCATOR.lido());
        BURNER = IBurnerForRedeemsBuffer(LOCATOR.burner());
        WITHDRAWAL_QUEUE = IWithdrawalQueueForRedeemsBuffer(LOCATOR.withdrawalQueue());
        HASH_CONSENSUS = IHashConsensus(_hashConsensus);
    }

    function initialize(address _admin) external {
        if (_admin == address(0)) revert ZeroRecipient();
        LIDO.approve(address(BURNER), type(uint256).max);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /**
     * @notice Redeem stETH for ETH from the reserve.
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

        uint256 available = _reserveBalance - _redeemedEther.value;
        if (etherAmount > available) {
            revert InsufficientReserve(etherAmount, available);
        }

        LIDO.transferSharesFrom(msg.sender, address(this), sharesAmount);
        BURNER.requestBurnShares(address(this), sharesAmount);

        // RefSlotCache auto-snapshots: on first increment in a new frame,
        // caches the pre-increment value as the refSlot snapshot.
        _redeemedEther = _redeemedEther.withValueIncrease(HASH_CONSENSUS, uint104(etherAmount));
        _redeemedShares = _redeemedShares.withValueIncrease(HASH_CONSENSUS, uint104(sharesAmount));

        (bool success,) = _ethRecipient.call{value: etherAmount}("");
        if (!success) revert ETHTransferFailed(_ethRecipient, etherAmount);

        emit Redeemed(msg.sender, _ethRecipient, _stETHAmount, sharesAmount, etherAmount);
    }

    // ── Report interface ─────────────────────────────────────────────────

    /// @notice Redeemed ether as of the current refSlot (for Accounting).
    function getRedeemedEtherForReport() external view returns (uint256) {
        return _redeemedEther.getValueForLastRefSlot(HASH_CONSENSUS);
    }

    /// @notice Redeemed shares as of the current refSlot (for Accounting).
    function getRedeemedSharesForReport() external view returns (uint256) {
        return _redeemedShares.getValueForLastRefSlot(HASH_CONSENSUS);
    }

    /// @notice Current total redeemed ether (including post-refSlot).
    function getRedeemedEther() external view returns (uint256) {
        return _redeemedEther.value;
    }

    /// @notice Current total redeemed shares (including post-refSlot).
    function getRedeemedShares() external view returns (uint256) {
        return _redeemedShares.value;
    }

    function fundReserve() external payable {
        if (msg.sender != address(LIDO)) revert NotLido();
        _reserveBalance += msg.value;
        emit ReserveFunded(msg.value);
    }

    /**
     * @notice Returns unredeemed ETH to Lido and resets counters.
     */
    function withdrawUnredeemed() external {
        if (msg.sender != address(LIDO)) revert NotLido();
        uint256 amount = _reserveBalance - _redeemedEther.value;
        _reserveBalance = 0;
        _redeemedEther = RefSlotCache.Uint104WithCache(0, 0, 0);
        _redeemedShares = RefSlotCache.Uint104WithCache(0, 0, 0);
        if (amount > 0) {
            LIDO.receiveFromRedeemsBuffer{value: amount}();
        }
    }

    // ── Recovery ─────────────────────────────────────────────────────────

    function recoverERC20(address _token, uint256 _amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_token == address(LIDO)) revert StETHRecoveryNotAllowed();
        IERC20(_token).transfer(msg.sender, _amount);
    }

    function recoverStETHShares() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 shares = LIDO.sharesOf(address(this));
        if (shares > 0) {
            LIDO.transferShares(msg.sender, shares);
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

    receive() external payable {
        revert DirectETHTransferNotAllowed();
    }
}
