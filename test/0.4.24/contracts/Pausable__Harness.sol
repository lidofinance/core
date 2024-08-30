// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Pausable} from "contracts/0.4.24/utils/Pausable.sol";

contract Pausable__Harness is Pausable {
    function stop() external {
        _stop();
    }

    function resume() external {
        _resume();
    }
}
