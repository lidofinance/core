// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.9;

import {UnstructuredStorage} from "contracts/common/lib/UnstructuredStorage.sol";

/**
 * @title PausableUntil
 * @notice allows to pause the contract for a specific duration or indefinitely
 */
abstract contract PausableUntil {
    using UnstructuredStorage for bytes32;

    /// Contract resume/pause control storage slot
    bytes32 internal constant RESUME_SINCE_TIMESTAMP_POSITION = keccak256("lido.PausableUntil.resumeSinceTimestamp");
    /// Special value for the infinite pause
    uint256 public constant PAUSE_INFINITELY = type(uint256).max;

    /// @notice Emitted when paused by the `pauseFor` or `pauseUntil` call
    event Paused(uint256 duration);
    /// @notice Emitted when resumed by the `resume` call
    event Resumed();

    error ZeroPauseDuration();
    error PausedExpected();
    error ResumedExpected();
    error PauseUntilMustBeInFuture();

    /// @notice Reverts if paused
    modifier whenResumed() {
        _checkResumed();
        _;
    }

    /// @notice Returns whether the contract is paused
    function isPaused() public view returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02860000, 1037618709126) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02860001, 0) }
        return block.timestamp < RESUME_SINCE_TIMESTAMP_POSITION.getStorageUint256();
    }

    /// @notice Returns one of:
    ///  - PAUSE_INFINITELY if paused infinitely returns
    ///  - the timestamp when the contract get resumed if paused for specific duration
    ///  - some timestamp in past if not paused
    function getResumeSinceTimestamp() external view returns (uint256) {
        return RESUME_SINCE_TIMESTAMP_POSITION.getStorageUint256();
    }

    function _checkPaused() internal view {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a10000, 1037618709153) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a10001, 0) }
        if (!isPaused()) {
            revert PausedExpected();
        }
    }

    function _checkResumed() internal view {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a20000, 1037618709154) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a20001, 0) }
        if (isPaused()) {
            revert ResumedExpected();
        }
    }

    function _resume() internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a40000, 1037618709156) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a40001, 0) }
        _checkPaused();
        RESUME_SINCE_TIMESTAMP_POSITION.setStorageUint256(block.timestamp);
        emit Resumed();
    }

    function _pauseFor(uint256 _duration) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a50000, 1037618709157) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a50001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a51000, _duration) }
        _checkResumed();
        if (_duration == 0) revert ZeroPauseDuration();

        uint256 resumeSince;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000007b,resumeSince)}
        if (_duration == PAUSE_INFINITELY) {
            resumeSince = PAUSE_INFINITELY;
        } else {
            resumeSince = block.timestamp + _duration;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000007d,resumeSince)}
        }
        _setPausedState(resumeSince);
    }

    function _pauseUntil(uint256 _pauseUntilInclusive) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a30000, 1037618709155) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a30001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a31000, _pauseUntilInclusive) }
        _checkResumed();
        if (_pauseUntilInclusive < block.timestamp) revert PauseUntilMustBeInFuture();

        uint256 resumeSince;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000007c,resumeSince)}
        if (_pauseUntilInclusive != PAUSE_INFINITELY) {
            resumeSince = _pauseUntilInclusive + 1;
        } else {
            resumeSince = PAUSE_INFINITELY;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000007e,resumeSince)}
        }
        _setPausedState(resumeSince);
    }

    function _setPausedState(uint256 _resumeSince) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a60000, 1037618709158) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a60001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a61000, _resumeSince) }
        RESUME_SINCE_TIMESTAMP_POSITION.setStorageUint256(_resumeSince);
        if (_resumeSince == PAUSE_INFINITELY) {
            emit Paused(PAUSE_INFINITELY);
        } else {
            emit Paused(_resumeSince - block.timestamp);
        }
    }
}
