// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";
import {Confirmations} from "./Confirmations.sol";

/**
 * @title AccessControlConfirmable
 * @author Lido
 * @notice An extension of AccessControlEnumerable that allows executing functions by mutual confirmation.
 * @dev This contract extends Confirmations and AccessControlEnumerable and adds a confirmation mechanism.
 */
abstract contract AccessControlConfirmable is AccessControlEnumerable, Confirmations {

    constructor() {
        __Confirmations_init();
    }

    function _isValidConfirmer(bytes32 _role) internal view override returns (bool) {
        return hasRole(_role, msg.sender);
    }
}
