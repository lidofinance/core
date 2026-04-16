// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";
import {AccessControlEnumerableUpgradeable} from
    "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";
import {IRefSlotStore} from "contracts/common/interfaces/IRefSlotStore.sol";

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
 * @author Lido
 * @notice Holds reserve ETH for instant stETH-to-ETH redemptions
 */
contract RedeemsBuffer is PausableUntil, AccessControlEnumerableUpgradeable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    bytes32 public constant PAUSE_ROLE = keccak256("RedeemsBuffer.PauseRole");
    bytes32 public constant RESUME_ROLE = keccak256("RedeemsBuffer.ResumeRole");
    bytes32 public constant REDEEMER_ROLE = keccak256("RedeemsBuffer.RedeemerRole");
    bytes32 public constant RECOVER_ROLE = keccak256("RedeemsBuffer.RecoverRole");

    bytes32 public constant REDEEMED_ETHER_SLOT = keccak256("RedeemsBuffer.redeemedEther");

    ILidoForRedeemsBuffer public immutable LIDO;
    IBurnerForRedeemsBuffer public immutable BURNER;
    IWithdrawalQueueForRedeemsBuffer public immutable WITHDRAWAL_QUEUE;
    IRefSlotStore public immutable STORE;

    uint256 private _reserveBalance;

    event Redeemed(
        address indexed caller,
        address indexed ethRecipient,
        uint256 stETHAmount,
        uint256 sharesAmount,
        uint256 etherAmount
    );
    event ReserveFunded(uint256 amount);
    event ERC20Recovered(
        address indexed requestedBy,
        address indexed token,
        uint256 amount,
        address indexed recipient
    );
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
    error ETHTransferFailed(address recipient, uint256 amount);
    error StETHRecoveryNotAllowed();
    error DirectETHTransfer();

    constructor(address _lido, address _burner, address _withdrawalQueue, address _store) {
        LIDO = ILidoForRedeemsBuffer(_lido);
        BURNER = IBurnerForRedeemsBuffer(_burner);
        WITHDRAWAL_QUEUE = IWithdrawalQueueForRedeemsBuffer(_withdrawalQueue);
        STORE = IRefSlotStore(_store);
        _disableInitializers();
    }

    /**
      * @notice One-time proxy initializer
      * @param _admin address to be granted DEFAULT_ADMIN_ROLE
      */
    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert AdminCannotBeZero();
        __AccessControlEnumerable_init();
        LIDO.approve(address(BURNER), type(uint256).max);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /**
      * @notice Returns the current initialized version of the contract
      */
    function getContractVersion() external view returns (uint256) {
        return _getInitializedVersion();
    }

    /**
      * @notice Exchange stETH for ETH from the reserve
      * @param _stETHAmount amount of stETH to redeem
      * @param _ethRecipient address that receives the ETH
      */
    function redeem(uint256 _stETHAmount, address _ethRecipient) external onlyRole(REDEEMER_ROLE) whenResumed {
        if (_stETHAmount == 0) revert ZeroAmount();
        if (_ethRecipient == address(0)) revert ZeroRecipient();
        if (LIDO.isStopped()) revert LidoStopped();
        if (WITHDRAWAL_QUEUE.isBunkerModeActive()) revert BunkerModeActive();
        if (WITHDRAWAL_QUEUE.isPaused()) revert WithdrawalQueuePaused();

        uint256 sharesAmount = LIDO.getSharesByPooledEth(_stETHAmount);
        uint256 etherAmount = LIDO.getPooledEthByShares(sharesAmount);

        uint256 redeemedBefore = STORE.getValue(REDEEMED_ETHER_SLOT);
        uint256 available = _reserveBalance - redeemedBefore;
        if (etherAmount > available) {
            revert InsufficientReserve(etherAmount, available);
        }

        LIDO.transferSharesFrom(msg.sender, address(this), sharesAmount);
        BURNER.requestBurnShares(address(this), sharesAmount);

        STORE.set(REDEEMED_ETHER_SLOT, (redeemedBefore + etherAmount).toUint104());

        (bool success,) = _ethRecipient.call{value: etherAmount}("");
        if (!success) revert ETHTransferFailed(_ethRecipient, etherAmount);

        emit Redeemed(msg.sender, _ethRecipient, _stETHAmount, sharesAmount, etherAmount);
    }

    // ── Read interface ──────────────────────────────────────────────────

    /**
      * @notice Total ether redeemed since the last reconciliation (live value)
      */
    function getRedeemedEther() external view returns (uint256) {
        return STORE.getValue(REDEEMED_ETHER_SLOT);
    }

    /**
      * @notice Redeemed ether as of the last oracle frame boundary (snapshot for Accounting)
      */
    function getRedeemedEtherForReport() external view returns (uint256) {
        return STORE.getSnapshotValue(REDEEMED_ETHER_SLOT);
    }

    /**
      * @notice Tracked reserve ETH for the current cycle; zeroed on `withdrawUnredeemed`, refilled by `fundReserve`
      */
    function getReserveBalance() external view returns (uint256) {
        return _reserveBalance;
    }

    // ── Lido callbacks ──────────────────────────────────────────────────

    /**
      * @notice Receives ETH from Lido to replenish the reserve. Lido-only.
      */
    function fundReserve() external payable {
        if (msg.sender != address(LIDO)) revert NotLido();
        _reserveBalance += msg.value;
        emit ReserveFunded(msg.value);
    }

    /**
      * @notice Returns unredeemed ETH to Lido, preserving any post-refSlot carry. Lido-only.
      * @param _settledEther ether amount Accounting processed this report (the snapshot value)
      */
    function withdrawUnredeemed(uint256 _settledEther) external {
        if (msg.sender != address(LIDO)) revert NotLido();
        uint256 redeemed = STORE.getValue(REDEEMED_ETHER_SLOT);
        uint256 unredeemed = _reserveBalance - redeemed;

        _reserveBalance = 0;
        STORE.reset(REDEEMED_ETHER_SLOT);

        uint256 carry = redeemed - _settledEther;
        if (carry > 0) {
            STORE.set(REDEEMED_ETHER_SLOT, carry.toUint104());
        }

        if (unredeemed > 0) {
            LIDO.receiveFromRedeemsBuffer{value: unredeemed}();
        }
    }

    // ── Recovery ─────────────────────────────────────────────────────────

    /**
      * @notice Recovers a given amount of an ERC20 token to the recipient
      * @param _token address of the ERC20 token to recover
      * @param _amount amount of tokens to recover
      * @param _recipient address that receives the recovered tokens
      */
    function recoverERC20(address _token, uint256 _amount, address _recipient) external onlyRole(RECOVER_ROLE) {
        if (_recipient == address(0)) revert ZeroRecipient();
        if (_token == address(LIDO)) revert StETHRecoveryNotAllowed();
        emit ERC20Recovered(msg.sender, _token, _amount, _recipient);
        IERC20(_token).safeTransfer(_recipient, _amount);
    }

    /**
      * @notice Recovers any stETH shares stuck on the contract to the recipient
      * @param _recipient address that receives the recovered shares
      */
    function recoverStETHShares(address _recipient) external onlyRole(RECOVER_ROLE) {
        if (_recipient == address(0)) revert ZeroRecipient();
        uint256 shares = LIDO.sharesOf(address(this));
        if (shares > 0) {
            emit StETHSharesRecovered(msg.sender, shares, _recipient);
            LIDO.transferShares(_recipient, shares);
        }
    }

    /**
      * @notice Recovers ether stuck on the contract (e.g. from selfdestruct) to the recipient
      * @param _recipient address that receives the recovered ether
      */
    function recoverEther(address _recipient) external onlyRole(RECOVER_ROLE) {
        if (_recipient == address(0)) revert ZeroRecipient();
        uint256 amount = address(this).balance + STORE.getValue(REDEEMED_ETHER_SLOT) - _reserveBalance;
        if (amount > 0) {
            emit EtherRecovered(msg.sender, amount, _recipient);
            (bool success,) = _recipient.call{value: amount}("");
            if (!success) revert ETHTransferFailed(_recipient, amount);
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

    /// @dev Rejects direct ETH transfers; use `fundReserve` (Lido) instead.
    receive() external payable {
        revert DirectETHTransfer();
    }
}
