// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

import {IZeroArgument} from "../interfaces/IZeroArgument.sol";

/**
 * @title MassAccessControl
 * @author Lido
 * @notice Mass-grants and revokes roles.
 */
abstract contract MassAccessControl is AccessControlEnumerable, IZeroArgument {
    /**
     * @notice Grants multiple roles to a single account.
     * @param _account The address to which the roles will be granted.
     * @param _roles An array of bytes32 role identifiers to be granted.
     * @dev Performs the role admin checks internally.
     */
    function grantRoles(address _account, bytes32[] memory _roles) external {
        if (_account == address(0)) revert ZeroArgument("_account");
        if (_roles.length == 0) revert ZeroArgument("_roles");

        for (uint256 i = 0; i < _roles.length; i++) {
            grantRole(_roles[i], _account);
        }
    }

    /**
     * @notice Mass-grants a single role to a single account.
     * @param _accounts An array of addresses to which the roles will be granted.
     * @param _roles An array of bytes32 role identifiers to be granted.
     */
    function grantRoles(address[] memory _accounts, bytes32[] memory _roles) external {
        if (_accounts.length == 0) revert ZeroArgument("_accounts");
        if (_roles.length == 0) revert ZeroArgument("_roles");
        if (_accounts.length != _roles.length) revert LengthMismatch();

        for (uint256 i = 0; i < _accounts.length; i++) {
            grantRole(_roles[i], _accounts[i]);
        }
    }

    /**
     * @notice Revokes multiple roles from a single account.
     * @param _account The address from which the roles will be revoked.
     * @param _roles An array of bytes32 role identifiers to be revoked.
     */
    function revokeRoles(address _account, bytes32[] memory _roles) external {
        if (_account == address(0)) revert ZeroArgument("_account");
        if (_roles.length == 0) revert ZeroArgument("_roles");

        for (uint256 i = 0; i < _roles.length; i++) {
            revokeRole(_roles[i], _account);
        }
    }

    /**
     * @notice Mass-revokes a single role from a single account.
     * @param _accounts An array of addresses from which the roles will be revoked.
     * @param _roles An array of bytes32 role identifiers to be revoked.
     */
    function revokeRoles(address[] memory _accounts, bytes32[] memory _roles) external {
        if (_accounts.length == 0) revert ZeroArgument("_accounts");
        if (_roles.length == 0) revert ZeroArgument("_roles");
        if (_accounts.length != _roles.length) revert LengthMismatch();

        for (uint256 i = 0; i < _accounts.length; i++) {
            revokeRole(_roles[i], _accounts[i]);
        }
    }

    /**
     * @notice Error thrown when the length of two arrays does not match
     */
    error LengthMismatch();
}
