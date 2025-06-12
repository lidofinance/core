// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Confirmations} from "./Confirmations.sol";

/**
 * @title Confirmable2Addresses
 * @author Lido
 * @notice An extension of Confirmations that allows exectuing functions by mutual confirmation.
 * @dev In this implementation, roles are treated as addresses.
 */
abstract contract Confirmable2Addresses is Confirmations {
    
    function _collectAndCheckConfirmations(bytes calldata _calldata, address _role1, address _role2) internal returns (bool) {
        bytes32[] memory roles = new bytes32[](2);
        roles[0] = bytes32(uint256(uint160(_role1)));
        roles[1] = bytes32(uint256(uint160(_role2)));

        return _collectAndCheckConfirmations(_calldata, roles);
    }

    function _isValidConfirmer(bytes32 _roleAsAddress) internal view override returns (bool) {
        return _roleAsAddress == bytes32(uint256(uint160(msg.sender)));
    }
}
