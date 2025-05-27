// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Confirmations} from "./Confirmations.sol";
/**
 * @title Confirmable
 * @author Lido
 * @notice An extension of Confirmations that allows exectuing functions by mutual confirmation.
 * @dev This contract extends Confirmations and adds a confirmation mechanism in the form of a modifier.
 */
abstract contract Confirmable is Confirmations {
    function _isValidConfirmer(uint256 _confirmerIndex, bytes32[] memory _confirmers) internal view override returns (bool) {
        return _confirmers[_confirmerIndex] == bytes32(uint256(uint160(msg.sender)));
    }
}
