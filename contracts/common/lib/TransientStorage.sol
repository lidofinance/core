// SPDX-License-Identifier: GPL-3.0
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.24 <0.9.0;

/**
 * @title  Transient storage primitives.
 * @author KRogLA
 * @notice Provides low level functionality for reading/writing transient storage (EIP-1153) values
 *         and methods for storing/reading/clearing arrays.
 */
library TransientStorage {
    // helpers
    function __put(bytes32 slot, uint256 val) internal {
        assembly {
            tstore(slot, val)
        }
    }

    // прочитать значение (в текущей nonce)
    function __get(bytes32 slot) internal view returns (uint256 val) {
        assembly {
            val := tload(slot)
        }
    }

    function __storeArray(bytes32 slot, uint256[] memory values) internal {
        uint256 len = values.length;
        // store length of array
        __put(slot, len);

        unchecked {
            uint256 slotItems = uint256(slot) + 1;
            for (uint256 i = 0; i < len; ++i) {
                __put(bytes32(slotItems + i), values[i]);
            }
        }
    }

    function __readArray(bytes32 slot) internal view returns (uint256[] memory values) {
        // load length of array
        uint256 len = __get(slot);
        values = new uint256[](len);

        unchecked {
            uint256 slotItems = uint256(slot) + 1;
            for (uint256 i = 0; i < len; ++i) {
                values[i] = __get(bytes32(slotItems + i));
            }
        }
    }

    function __clearArray(bytes32 slot) internal {
        uint256 len = __get(slot);
        __put(slot, 0);

        unchecked {
            uint256 slotItems = uint256(slot) + 1;
            for (uint256 i = 0; i < len; ++i) {
                __put(bytes32(slotItems + i), 0);
            }
        }
    }
}
