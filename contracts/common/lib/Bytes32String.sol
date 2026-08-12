// SPDX-License-Identifier: GPL-3.0
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

/**
 * @title Converts bytes32 to string and vice versa
 * @author KRogLA
 * @notice Allows packing and unpacking short strings (length < 32 bytes) to/from bytes32
 *         (e.g., to store a string in an immutable variable).
 * @dev Packed bytes32 layout: [31 bytes of data][1 byte of length]
 */
library Bytes32String {
    error StringTooLong();
    /// @notice Packs a string into bytes32.
    /// @dev Reverts if the string length is greater than 31 bytes.
    function toBytes32(string memory s) internal pure returns (bytes32 r) {
        uint256 len = bytes(s).length;
        if (len > 31) revert StringTooLong();
        assembly ("memory-safe") {
            let data := mload(add(s, 32))
            // Clear potentially dirty lower (32 - len) bytes using a mask.
            let mask := shl(mul(sub(32, len), 8), not(0))
            r := or(and(data, mask), len)
        }
    }

    /// @notice Unpacks a bytes32 value into a string.
    function toString(bytes32 b) internal pure returns (string memory s) {
        assembly ("memory-safe") {
            let len := and(b, 0xFF)
            s := mload(0x40)
            mstore(s, len)
            // Zero out the last byte (length).
            mstore(add(s, 32), and(b, not(0xFF)))
            mstore(0x40, add(s, 64))
        }
    }
}
