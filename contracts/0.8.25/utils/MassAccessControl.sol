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
    struct Ticket {
        address account;
        bytes32 role;
    }

    /**
     * @notice Mass-grants multiple roles to multiple accounts.
     * @param _tickets An array of Tickets.
     * @dev Performs the role admin checks internally.
     */
    function grantRoles(Ticket[] memory _tickets) external {
        if (_tickets.length == 0) revert ZeroArgument("_tickets");

        for (uint256 i = 0; i < _tickets.length; i++) {
            grantRole(_tickets[i].role, _tickets[i].account);
        }
    }

    /**
     * @notice Mass-revokes multiple roles from multiple accounts.
     * @param _tickets An array of Tickets.
     * @dev Performs the role admin checks internally.
     */
    function revokeRoles(Ticket[] memory _tickets) external {
        if (_tickets.length == 0) revert ZeroArgument("_tickets");

        for (uint256 i = 0; i < _tickets.length; i++) {
            revokeRole(_tickets[i].role, _tickets[i].account);
        }
    }
}
