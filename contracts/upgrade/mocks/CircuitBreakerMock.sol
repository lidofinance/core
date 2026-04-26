// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {IPausableUntil} from "contracts/common/interfaces/IPausableUntil.sol";

contract CircuitBreakerMock is ICircuitBreaker {
    error SenderNotPauser();
    error PauseFailed();

    uint256 internal immutable PAUSE_DURATION;
    mapping(address pausable => address pauser) private _pausers;

    constructor(uint256 _duration) {
        PAUSE_DURATION = _duration;
    }

    function pause(address _pausable) external {
        if (msg.sender != _pausers[_pausable]) revert SenderNotPauser();

        _pausers[_pausable] = address(0);
        IPausableUntil pausable = IPausableUntil(_pausable);
        pausable.pauseFor(PAUSE_DURATION);
        if (!pausable.isPaused()) revert PauseFailed();
    }

    function registerPauser(address _pausable, address _newPauser) external {
        _pausers[_pausable] = _newPauser;
    }

    function getPauser(address _pausable) external view returns (address) {
        return _pausers[_pausable];
    }
}
