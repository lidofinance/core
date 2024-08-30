// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import "contracts/0.8.9/utils/PausableUntil.sol";

contract PausableUntil__Harness is PausableUntil {
    function modifierWhenPaused() external view whenPaused {}

    function modifierWhenResumed() external view whenResumed {}

    function harness__pauseFor(uint256 _duration) external {
        _pauseFor(_duration);
    }

    function harness__pauseUntil(uint256 _pauseUntilInclusive) external {
        _pauseUntil(_pauseUntilInclusive);
    }

    function harness__resume() external {
        _resume();
    }

    function harness__setPauseState(uint256 _resumeSince) external {
        _setPausedState(_resumeSince);
    }
}
