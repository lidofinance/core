// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";

contract OracleDaemonConfig is AccessControlEnumerable {

    bytes32 public constant CONFIG_MANAGER_ROLE = keccak256("CONFIG_MANAGER_ROLE");

    mapping(string => bytes) private values;

    constructor(address _admin, address[] memory _configManagers) {
        if (_admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        for (uint256 i = 0; i < _configManagers.length; ) {
            if (_configManagers[i] == address(0)) revert ZeroAddress();
            _grantRole(CONFIG_MANAGER_ROLE, _configManagers[i]);

            unchecked {
                ++i;
            }
        }
    }

    function set(string calldata _key, bytes calldata _value) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (values[_key].length > 0) revert ValueExists(_key);
        if (_value.length == 0) revert EmptyValue(_key);
        values[_key] = _value;

        emit ConfigValueSet(_key, _value);
    }

    function update(string calldata _key, bytes calldata _value) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (values[_key].length == 0) revert ValueDoesntExist(_key);
        if (_value.length == 0) revert EmptyValue(_key);
        if (keccak256(values[_key]) == keccak256(_value)) revert ValueIsSame(_key, _value);
        values[_key] = _value;

        emit ConfigValueUpdated(_key, _value);
    }

    function unset(string calldata _key) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (values[_key].length == 0) revert ValueDoesntExist(_key);
        delete values[_key];

        emit ConfigValueUnset(_key);
    }

    function get(string calldata _key) external view returns (bytes memory) {
        if (values[_key].length == 0) revert ValueDoesntExist(_key);

        return values[_key];
    }

    function getList(string[] calldata _keys) external view returns (bytes[] memory) {
        bytes[] memory results = new bytes[](_keys.length);

        for (uint256 i = 0; i < _keys.length; ) {
            if (values[_keys[i]].length == 0) revert ValueDoesntExist(_keys[i]);

            results[i] = values[_keys[i]];

            unchecked {
                ++i;
            }
        }

        return results;
    }

    error ValueExists(string key);
    error EmptyValue(string key);
    error ValueDoesntExist(string key);
    error ZeroAddress();
    error ValueIsSame(string key, bytes value);

    event ConfigValueSet(string key, bytes value);
    event ConfigValueUpdated(string key, bytes value);
    event ConfigValueUnset(string key);
}
