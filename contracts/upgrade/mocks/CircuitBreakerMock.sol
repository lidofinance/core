// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";

error NotPauser(address caller, address pausable, address expectedPauser);
error PauseCallFailed(address pausable);

contract CircuitBreakerMock is ICircuitBreaker {
    mapping(address pausable => address pauser) private _pausers;

    function pause(address _pausable) external {
        address pauser = _pausers[_pausable];
        if (msg.sender != pauser) {
            revert NotPauser(msg.sender, _pausable, pauser);
        }

        (bool success,) = _pausable.call(abi.encodeWithSignature("pauseFor(uint256)", 60)); // 60 sec
        if (!success) {
            revert PauseCallFailed(_pausable);
        }
    }

    function registerPauser(address _pausable, address _newPauser) external {
        _pausers[_pausable] = _newPauser;
    }

    function getPauser(address _pausable) external view returns (address) {
        return _pausers[_pausable];
    }
}
