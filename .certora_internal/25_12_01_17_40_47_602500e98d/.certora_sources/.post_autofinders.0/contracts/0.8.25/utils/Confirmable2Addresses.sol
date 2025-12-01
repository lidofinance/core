// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Confirmations} from "./Confirmations.sol";

/**
 * @title Confirmable2Addresses
 * @author Lido
 * @notice An extension of Confirmations that allows executing functions by mutual confirmation.
 * @dev In this implementation, roles are treated as addresses.
 */
abstract contract Confirmable2Addresses is Confirmations {

    function _collectAndCheckConfirmations(bytes calldata _calldata, address _role1, address _role2) internal returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000c0000, 1037618708492) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000c0001, 4) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000c3000, _calldata.offset) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000c2000, _calldata.length) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000c1001, _role1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000c1002, _role2) }
        bytes32[] memory roles = new bytes32[](2);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010017,0)}
        roles[0] = bytes32(uint256(uint160(_role1)));bytes32 certora_local24 = roles[0];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000018,certora_local24)}
        roles[1] = bytes32(uint256(uint160(_role2)));bytes32 certora_local25 = roles[1];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000019,certora_local25)}

        return _collectAndCheckConfirmations(_calldata, roles);
    }

    function _isValidConfirmer(bytes32 _roleAsAddress) internal view override returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000d0000, 1037618708493) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000d0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000d1000, _roleAsAddress) }
        return _roleAsAddress == bytes32(uint256(uint160(msg.sender)));
    }
}
