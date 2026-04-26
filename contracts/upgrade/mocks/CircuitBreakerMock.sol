// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {IPausableUntil} from "contracts/common/interfaces/IPausableUntil.sol";

contract CircuitBreakerMock is ICircuitBreaker {
    error NotPauser(address caller, address pausable, address expectedPauser);

    mapping(address pausable => address pauser) private _pausers;

    function pause(address _pausable) external {
        address pauser = _pausers[_pausable];
        if (msg.sender != pauser) {
            revert NotPauser(msg.sender, _pausable, pauser);
        }

        IPausableUntil(_pausable).pauseFor(60); // 60 sec
    }

    function registerPauser(address _pausable, address _newPauser) external {
        _pausers[_pausable] = _newPauser;
    }

    function getPauser(address _pausable) external view returns (address) {
        return _pausers[_pausable];
    }
}
