// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import {UnstructuredStorage} from "@aragon/os/contracts/common/UnstructuredStorage.sol";

contract Pausable {
    using UnstructuredStorage for bytes32;

    event Stopped();
    event Resumed();

    // keccak256("lido.Pausable.activeFlag")
    bytes32 internal constant ACTIVE_FLAG_POSITION =
        0x644132c4ddd5bb6f0655d5fe2870dcec7870e6be4758890f366b83441f9fdece;

    function _whenNotStopped() internal view {
        require(ACTIVE_FLAG_POSITION.getStorageBool(), "CONTRACT_IS_STOPPED");
    }

    function _whenStopped() internal view {
        require(!ACTIVE_FLAG_POSITION.getStorageBool(), "CONTRACT_IS_ACTIVE");
    }

    function isStopped() public view returns (bool) {
        return !ACTIVE_FLAG_POSITION.getStorageBool();
    }

    function _stop() internal {
        _whenNotStopped();

        ACTIVE_FLAG_POSITION.setStorageBool(false);
        emit Stopped();
    }

    function _resume() internal {
        _whenStopped();

        ACTIVE_FLAG_POSITION.setStorageBool(true);
        emit Resumed();
    }
}
