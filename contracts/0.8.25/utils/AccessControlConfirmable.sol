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
contract AccessControlConfirmable is AccessControlEnumerable, Confirmations {

    constructor() {
      __Confirmations_init();
    }

    modifier onlyConfirmed(bytes32[] memory _roles) {
        _setRoles(_roles);
        if (!_checkConfirmations(msg.data, _roles.length)) return;
        _;
    }

    function _setRoles(bytes32[] memory _roles) internal {
        uint256 len = _roles.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes32 slot = keccak256(abi.encodePacked(CONFIRMERS_SLOT, i));
            assembly {
                tstore(slot, mload(add(add(_roles, 0x20), mul(i, 0x20))))
            }
        }
    }

    function _getRoleAt(uint256 index) internal view returns (bytes32 role) {
        bytes32 slot = keccak256(abi.encodePacked(CONFIRMERS_SLOT, index));
        assembly {
            role := tload(slot)
        }
    }

    function _isValidConfirmer(uint256 _confirmerIndex) internal view override returns (bool) {
        return hasRole(_getRoleAt(_confirmerIndex), msg.sender);
    }

    function _emitEventConfirmation(address _sender, uint256 _index, uint256 _expiryTimestamp, bytes memory _data) internal override {
        emit RoleMemberConfirmed(_sender, _getRoleAt(_index), _expiryTimestamp, _data);
    }

    /**
     * @dev Emitted when a role member confirms.
     * @param member The address of the confirming member.
     * @param role The role of the confirming member.
     * @param expiryTimestamp The timestamp of the confirmation.
     * @param data The msg.data of the confirmation (selector + arguments).
     */
    event RoleMemberConfirmed(address indexed member, bytes32 indexed role, uint256 expiryTimestamp, bytes data);
}
