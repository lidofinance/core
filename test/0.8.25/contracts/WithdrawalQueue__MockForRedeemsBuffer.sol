// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract WithdrawalQueue__MockForRedeemsBuffer {
    bool private _bunkerMode;
    bool private _paused;

    function isBunkerModeActive() external view returns (bool) {
        return _bunkerMode;
    }

    function isPaused() external view returns (bool) {
        return _paused;
    }

    // Test helpers
    function setBunkerMode(bool _isBunker) external {
        _bunkerMode = _isBunker;
    }

    function setPaused(bool _isPaused) external {
        _paused = _isPaused;
    }
}
