// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

/// @title MeIfNobodyElse
/// @author Lido
/// @notice A library for mapping(address => address) that defaults to the key if the value is not set
library MeIfNobodyElse {
    /// @notice Returns the value for the key if it is set, otherwise returns the key
    function getValueOrKey(mapping(address => address) storage map, address key) internal view returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02740000, 1037618709108) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02740001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02741000, map.slot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02741001, key) }
        address value = map[key];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000006,value)}
        return value == address(0) ? key : value;
    }

    /// @notice Sets the value for the key if it is not the key itself, otherwise resets the value to the zero address
    function setOrReset(mapping(address => address) storage map, address key, address value) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02750000, 1037618709109) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02750001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02751000, map.slot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02751001, key) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02751002, value) }
        map[key] = key == value ? address(0) : value;address certora_local7 = map[key];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000007,certora_local7)}
    }
}
