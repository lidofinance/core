// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";
import {Confirmations} from "./Confirmations.sol";
/**
 * @title AccessControlConfirmable
 * @author Lido
 * @notice An extension of AccessControlEnumerable that allows exectuing functions by mutual confirmation.
 * @dev This contract extends Confirmations and AccessControlEnumerable and adds a confirmation mechanism in the form of a modifier.
 */
abstract contract AccessControlConfirmable is AccessControlEnumerable, Confirmations {

    constructor() {
        __Confirmations_init();
    }

    modifier onlyConfirmed(bytes32[] memory _roles) {
        if (!_checkConfirmations(msg.data, _roles)) return;
        _;
    }

    function _isValidConfirmer(bytes32 _role) internal view override returns (bool) {
        return hasRole(_role, msg.sender);
    }
}
