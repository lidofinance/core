// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

/// @title MeIfNobodyElse
/// @author Lido
/// @notice A library for mapping(address => address) that defaults to the key if the value is not set
library MeIfNobodyElse {
    /// @notice Returns the value for the key if it is set, otherwise returns the key
    function getValueOrKey(mapping(address => address) storage map, address key) internal view returns (address) {
        address value = map[key];
        return value == address(0) ? key : value;
    }

    /// @notice Sets the value for the key if it is not the key itself, otherwise resets the value to the zero address
    function setOrReset(mapping(address => address) storage map, address key, address value) internal {
        map[key] = key == value ? address(0) : value;
    }
}
