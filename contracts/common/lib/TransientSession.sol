// SPDX-License-Identifier: GPL-3.0
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.24 <0.9.0;

import {TransientStorage} from "contracts/common/lib/TransientStorage.sol";

/**
 * @title  Transient storage session.
 * @author KRogLA
 * @notice Provides functionality for managing transient storage sessions (based on caller nonce)
 *         and wrappers for storing/reading/clearing arrays.
 */
library TransientSession {
    using TransientStorage for bytes32;

    bytes32 private constant BASE = keccak256("TransientSession.base");

    function _nonceSlot(address caller) private pure returns (bytes32 slot) {
        return keccak256(abi.encode(BASE, caller));
    }

    function _getNonce(address caller) private view returns (uint256 nonce) {
        return _nonceSlot(caller).__get();
    }

    function _itemSlot(bytes32 key) internal view returns (bytes32 slot) {
        address caller = msg.sender;
        uint256 nonce = _getNonce(caller);
        return keccak256(abi.encode(BASE, caller, nonce, key));
    }

    function _bumpNonce(address caller) private {
        bytes32 slot = _nonceSlot(caller);
        unchecked {
            slot.__put(slot.__get() + 1);
        }
    }

    function _invalidateSession() internal {
        _bumpNonce(msg.sender);
    }

    // storage wrappers
    function _storeArray(bytes32 key, uint256[] memory values) internal {
        _itemSlot(key).__storeArray(values);
    }

    function _readArray(bytes32 key) internal view returns (uint256[] memory values) {
        return _itemSlot(key).__readArray();
    }

    function _clearArray(bytes32 key) internal {
        _itemSlot(key).__clearArray();
    }
}
