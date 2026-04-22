// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";
import {AccessControlEnumerableUpgradeable} from
    "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {IWithdrawalQueue} from "contracts/common/interfaces/IWithdrawalQueue.sol";

import {RefSlotCache} from "./vaults/lib/RefSlotCache.sol";

/**
 * @title RedeemsBuffer
 * @author Lido
 * @notice Holds reserve ETH for instant stETH-to-ETH redemptions
 */
contract RedeemsBuffer is PausableUntil, AccessControlEnumerableUpgradeable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using RefSlotCache for RefSlotCache.Uint104WithCache;

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 public constant REDEEMER_ROLE = keccak256("REDEEMER_ROLE");
    bytes32 public constant RECOVER_ROLE = keccak256("RECOVER_ROLE");

    ILido public immutable LIDO;
    IBurner public immutable BURNER;
    IWithdrawalQueue public immutable WITHDRAWAL_QUEUE;
    IHashConsensus public immutable HASH_CONSENSUS;

    uint256 private _reserveBalance;
    RefSlotCache.Uint104WithCache private _redeemedEther;
    RefSlotCache.Uint104WithCache private _redeemedShares;

    event Redeemed(
        address indexed caller,
        address indexed ethRecipient,
        uint256 requestedStETH,
        uint256 burnedShares,
        uint256 paidEther
    );
    event ReserveFunded(uint256 amount);
    event ERC20Recovered(address indexed requestedBy, address indexed token, uint256 amount, address indexed recipient);
    event StETHSharesRecovered(address indexed requestedBy, uint256 shares, address indexed recipient);
    event EtherRecovered(address indexed requestedBy, uint256 amount, address indexed recipient);

    error AdminCannotBeZero();
    error ZeroAmount();
    error ZeroRecipient();
    error LidoStopped();
    error BunkerModeActive();
    error WithdrawalQueuePaused();
    error InsufficientReserve(uint256 requested, uint256 available);
    error NotLido();
    error EthTransferFailed(address recipient, uint256 amount);
    error StETHRecoveryNotAllowed();
    error DirectETHTransfer();
    error SnapshotExceedsLiveValue(uint256 snapshot, uint256 live);

    constructor(address _lido, address _burner, address _withdrawalQueue, address _hashConsensus) {
        LIDO = ILido(_lido);
        BURNER = IBurner(_burner);
        WITHDRAWAL_QUEUE = IWithdrawalQueue(_withdrawalQueue);
        HASH_CONSENSUS = IHashConsensus(_hashConsensus);
        _disableInitializers();
    }

    /// @notice One-time proxy initializer
    /// @param _admin address granted `DEFAULT_ADMIN_ROLE`
    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert AdminCannotBeZero();
        __AccessControlEnumerable_init();
        LIDO.approve(address(BURNER), type(uint256).max);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice Returns the current initialized version of the contract
    function getContractVersion() external view returns (uint256) {
        return _getInitializedVersion();
    }

    /// @notice Exchange stETH for ETH from the reserve
    /// @param _stETHAmount amount of stETH to redeem
    /// @param _ethRecipient address that receives the ETH
    function redeem(uint256 _stETHAmount, address _ethRecipient) external onlyRole(REDEEMER_ROLE) whenResumed {
        if (_stETHAmount == 0) revert ZeroAmount();
        if (_ethRecipient == address(0)) revert ZeroRecipient();
        if (LIDO.isStopped()) revert LidoStopped();
        if (WITHDRAWAL_QUEUE.isBunkerModeActive()) revert BunkerModeActive();
        if (WITHDRAWAL_QUEUE.isPaused()) revert WithdrawalQueuePaused();

        uint256 sharesAmount = LIDO.getSharesByPooledEth(_stETHAmount);
        uint256 etherAmount = LIDO.getPooledEthByShares(sharesAmount);

        uint256 available = _reserveBalance - _redeemedEther.value;
        if (etherAmount > available) {
            revert InsufficientReserve(etherAmount, available);
        }

        LIDO.transferSharesFrom(msg.sender, address(this), sharesAmount);
        BURNER.requestBurnShares(address(this), sharesAmount);

        _redeemedEther = _redeemedEther.withValueIncrease(HASH_CONSENSUS, etherAmount.toUint104());
        _redeemedShares = _redeemedShares.withValueIncrease(HASH_CONSENSUS, sharesAmount.toUint104());

        (bool success,) = _ethRecipient.call{value: etherAmount}("");
        if (!success) revert EthTransferFailed(_ethRecipient, etherAmount);

        emit Redeemed(msg.sender, _ethRecipient, _stETHAmount, sharesAmount, etherAmount);
    }

    // ── Read interface ──────────────────────────────────────────────────

    /// @notice Redeemed ether and shares since the last reconciliation (live values)
    function getRedeemed() external view returns (uint256 redeemedEther, uint256 redeemedShares) {
        return (_redeemedEther.value, _redeemedShares.value);
    }

    /// @notice Redeemed ether and shares as of the last oracle frame boundary (snapshot for Accounting)
    function getRedeemedForLastRefSlot() external view returns (uint256 redeemedEther, uint256 redeemedShares) {
        return (
            _redeemedEther.getValueForLastRefSlot(HASH_CONSENSUS),
            _redeemedShares.getValueForLastRefSlot(HASH_CONSENSUS)
        );
    }

    /// @notice Tracked reserve ETH for the current cycle; zeroed on `reconcile`, refilled by `fundReserve`
    function getReserveBalance() external view returns (uint256) {
        return _reserveBalance;
    }

    // ── Lido callbacks ──────────────────────────────────────────────────

    /// @notice Receives ETH from Lido to replenish the reserve. Lido-only.
    function fundReserve() external payable {
        if (msg.sender != address(LIDO)) revert NotLido();
        _reserveBalance += msg.value;
        emit ReserveFunded(msg.value);
    }

    /// @notice Reconciles the buffer with the processed oracle report and returns unredeemed ETH to Lido. Lido-only.
    /// @param _redeemedEtherForLastRefSlot ether snapshot Accounting consumed for this report
    /// @param _redeemedSharesForLastRefSlot shares snapshot Accounting consumed for this report
    /// @dev Subtracts the consumed snapshots, preserving any post-refSlot residue as the next cycle's starting value.
    function reconcile(uint256 _redeemedEtherForLastRefSlot, uint256 _redeemedSharesForLastRefSlot) external {
        if (msg.sender != address(LIDO)) revert NotLido();

        uint256 unredeemed = _reserveBalance - _redeemedEther.value;
        _reserveBalance = 0;

        uint48 currentRefSlot = uint48(_currentRefSlot());
        _resetCounter(_redeemedEther, _redeemedEtherForLastRefSlot, currentRefSlot);
        _resetCounter(_redeemedShares, _redeemedSharesForLastRefSlot, currentRefSlot);

        if (unredeemed > 0) {
            LIDO.receiveFromRedeemsBuffer{value: unredeemed}();
        }
    }

    /// @dev Subtracts `_consumed` from `_cache.value` and re-anchors the cache at `_refSlot`.
    ///      Reverts if `_consumed` exceeds the current live value.
    function _resetCounter(
        RefSlotCache.Uint104WithCache storage _cache,
        uint256 _consumed,
        uint48 _refSlot
    ) private {
        if (_consumed > _cache.value) revert SnapshotExceedsLiveValue(_consumed, _cache.value);
        _cache.value = (_cache.value - _consumed).toUint104();
        _cache.valueOnRefSlot = 0;
        _cache.refSlot = _refSlot;
    }

    // ── Recovery ─────────────────────────────────────────────────────────

    /// @notice Recovers an arbitrary ERC20 token (except stETH) to `_recipient`
    function recoverERC20(address _token, uint256 _amount, address _recipient) external onlyRole(RECOVER_ROLE) {
        if (_recipient == address(0)) revert ZeroRecipient();
        if (_token == address(LIDO)) revert StETHRecoveryNotAllowed();
        emit ERC20Recovered(msg.sender, _token, _amount, _recipient);
        IERC20(_token).safeTransfer(_recipient, _amount);
    }

    /// @notice Recovers stETH shares stuck on the contract to `_recipient`
    function recoverStETHShares(address _recipient) external onlyRole(RECOVER_ROLE) {
        if (_recipient == address(0)) revert ZeroRecipient();
        uint256 shares = LIDO.sharesOf(address(this));
        if (shares > 0) {
            emit StETHSharesRecovered(msg.sender, shares, _recipient);
            LIDO.transferShares(_recipient, shares);
        }
    }

    /// @notice Recovers ether stuck on the contract (e.g. from selfdestruct) to `_recipient`
    function recoverEther(address _recipient) external onlyRole(RECOVER_ROLE) {
        if (_recipient == address(0)) revert ZeroRecipient();
        uint256 amount = address(this).balance + _redeemedEther.value - _reserveBalance;
        if (amount > 0) {
            emit EtherRecovered(msg.sender, amount, _recipient);
            (bool success,) = _recipient.call{value: amount}("");
            if (!success) revert EthTransferFailed(_recipient, amount);
        }
    }

    // ── Pause ────────────────────────────────────────────────────────────

    /// @notice Pauses `redeem` for `_duration` seconds
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /// @notice Pauses `redeem` until (and including) `_pauseUntilInclusive` timestamp
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /// @notice Resumes `redeem`
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /// @dev Rejects direct ETH transfers; ETH enters via `fundReserve` (Lido-only).
    receive() external payable {
        revert DirectETHTransfer();
    }

    function _currentRefSlot() private view returns (uint256) {
        (uint256 refSlot,) = HASH_CONSENSUS.getCurrentFrame();
        return refSlot;
    }
}
