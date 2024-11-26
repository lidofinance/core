// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {StorageSlot} from "@openzeppelin/contracts-v5.0.2/utils/StorageSlot.sol";

contract Pausable {
    event Stopped();
    event Resumed();

    // keccak256("lido.Pausable.activeFlag")
    bytes32 internal constant ACTIVE_FLAG_POSITION =
        0x644132c4ddd5bb6f0655d5fe2870dcec7870e6be4758890f366b83441f9fdece;

    function _whenNotStopped() internal view {
        require(StorageSlot.getBooleanSlot(ACTIVE_FLAG_POSITION).value, "CONTRACT_IS_STOPPED");
    }

    function _whenStopped() internal view {
        require(!StorageSlot.getBooleanSlot(ACTIVE_FLAG_POSITION).value, "CONTRACT_IS_ACTIVE");
    }

    function isStopped() public view returns (bool) {
        return !StorageSlot.getBooleanSlot(ACTIVE_FLAG_POSITION).value;
    }

    function _stop() internal {
        _whenNotStopped();

        StorageSlot.getBooleanSlot(ACTIVE_FLAG_POSITION).value = false;
        emit Stopped();
    }

    function _resume() internal {
        _whenStopped();

        StorageSlot.getBooleanSlot(ACTIVE_FLAG_POSITION).value = true;
        emit Resumed();
    }
}
