// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.9;


library UnstructuredRefStorage {
    function storageMapUint256Address(bytes32 _position) internal pure returns (
        mapping(uint256 => address) storage result
    ) {
        assembly { result.slot := _position }
    }

    function storageMapAddressMapAddressBool(bytes32 _position) internal pure returns (
        mapping(address => mapping(address => bool)) storage result
    ) {
        assembly { result.slot := _position }
    }
}
