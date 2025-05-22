// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Confirmations} from "./Confirmations.sol";
/**
 * @title Confirmable
 * @author Lido
 * @notice An extension of Confirmations that allows exectuing functions by mutual confirmation.
 * @dev This contract extends Confirmations and adds a confirmation mechanism in the form of a modifier.
 */
contract Confirmable is Confirmations {

    function _setConfirmers(address[] memory _confirmers) internal {
        uint256 len = _confirmers.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes32 slot = keccak256(abi.encodePacked(CONFIRMERS_SLOT, i));
            assembly {
                tstore(slot, mload(add(add(_confirmers, 0x20), mul(i, 0x20))))
            }
        }
    }

    function _getConfirmerAt(uint256 index) internal view returns (address confirmer) {
        bytes32 slot = keccak256(abi.encodePacked(CONFIRMERS_SLOT, index));
        assembly {
            confirmer := tload(slot)
        }
    }

    function _isValidConfirmer(uint256 _confirmerIndex) internal view override returns (bool) {
        return _getConfirmerAt(_confirmerIndex) == msg.sender;
    }

    function _emitEventConfirmation(address _sender, uint256 _index, uint256 _expiryTimestamp, bytes memory _data) internal override {
        emit MemberConfirmed(_sender, _index, _expiryTimestamp, _data);
    }

    /**
     * @dev Emitted when a member confirms.
     * @param member The address of the confirming member.
     * @param index The index of the confirming member.
     * @param expiryTimestamp The timestamp of the confirmation.
     * @param data The msg.data of the confirmation (selector + arguments).
     */
    event MemberConfirmed(address indexed member, uint256 index, uint256 expiryTimestamp, bytes data);
}
