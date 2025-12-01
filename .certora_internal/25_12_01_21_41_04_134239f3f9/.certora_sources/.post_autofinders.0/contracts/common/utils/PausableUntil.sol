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
    function isPaused() public view returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030000, 1037618708483) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030001, 0) }
        return block.timestamp < RESUME_SINCE_TIMESTAMP_POSITION.getStorageUint256();
    }

    /// @notice Returns one of:
    ///  - PAUSE_INFINITELY if paused infinitely returns
    ///  - the timestamp when the contract get resumed if paused for specific duration
    ///  - some timestamp in past if not paused
    function getResumeSinceTimestamp() external view returns (uint256) {
        return RESUME_SINCE_TIMESTAMP_POSITION.getStorageUint256();
    }

    function _checkPaused() internal view {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007c0000, 1037618708604) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007c0001, 0) }
        if (!isPaused()) {
            revert PausedExpected();
        }
    }

    function _checkResumed() internal view {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007d0000, 1037618708605) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007d0001, 0) }
        if (isPaused()) {
            revert ResumedExpected();
        }
    }

    function _resume() internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007f0000, 1037618708607) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007f0001, 0) }
        _checkPaused();
        RESUME_SINCE_TIMESTAMP_POSITION.setStorageUint256(block.timestamp);
        emit Resumed();
    }

    function _pauseFor(uint256 _duration) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00800000, 1037618708608) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00800001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00801000, _duration) }
        _checkResumed();
        if (_duration == 0) revert ZeroPauseDuration();

        uint256 resumeSince;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000145,resumeSince)}
        if (_duration == PAUSE_INFINITELY) {
            resumeSince = PAUSE_INFINITELY;
        } else {
            resumeSince = block.timestamp + _duration;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000147,resumeSince)}
        }
        _setPausedState(resumeSince);
    }

    function _pauseUntil(uint256 _pauseUntilInclusive) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007e0000, 1037618708606) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007e0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007e1000, _pauseUntilInclusive) }
        _checkResumed();
        if (_pauseUntilInclusive < block.timestamp) revert PauseUntilMustBeInFuture();

        uint256 resumeSince;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000146,resumeSince)}
        if (_pauseUntilInclusive != PAUSE_INFINITELY) {
            resumeSince = _pauseUntilInclusive + 1;
        } else {
            resumeSince = PAUSE_INFINITELY;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000148,resumeSince)}
        }
        _setPausedState(resumeSince);
    }

    function _setPausedState(uint256 _resumeSince) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00810000, 1037618708609) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00810001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00811000, _resumeSince) }
        RESUME_SINCE_TIMESTAMP_POSITION.setStorageUint256(_resumeSince);
        if (_resumeSince == PAUSE_INFINITELY) {
            emit Paused(PAUSE_INFINITELY);
        } else {
            emit Paused(_resumeSince - block.timestamp);
        }
    }
}
