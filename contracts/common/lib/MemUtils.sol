// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>

// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24 <0.9.0;


library MemUtils {
    /**
     * @dev Allocates a memory byte array of `_len` bytes without zeroing it out.
     */
    function unsafeAllocateBytes(uint256 _len) internal pure returns (bytes memory result) {
        assembly {
            result := mload(0x40)
            mstore(result, _len)
            mstore(0x40, add(add(result, _len), 32))
        }
    }

    /**
     * Performs a memory copy of `_len` bytes from position `_src` to position `_dst`.
     */
    function memcpy(uint256 _src, uint256 _dst, uint256 _len) internal pure {
        assembly {
            // while al least 32 bytes left, copy in 32-byte chunks
            for { } gt(_len, 31) { } {
                mstore(_dst, mload(_src))
                _src := add(_src, 32)
                _dst := add(_dst, 32)
                _len := sub(_len, 32)
            }
            if gt(_len, 0) {
                // read the next 32-byte chunk from _dst, replace the first N bytes
                // with those left in the _src, and write the transformed chunk back
                let mask := sub(shl(mul(8, sub(32, _len)), 1), 1) // 2 ** (8 * (32 - _len)) - 1
                let srcMasked := and(mload(_src), not(mask))
                let dstMasked := and(mload(_dst), mask)
                mstore(_dst, or(dstMasked, srcMasked))
            }
        }
    }

    /**
     * Copies `_len` bytes from `_src`, starting at position `_srcStart`, into `_dst`, starting at position `_dstStart` into `_dst`.
     */
    function copyBytes(bytes memory _src, bytes memory _dst, uint256 _srcStart, uint256 _dstStart, uint256 _len) internal pure {
        require(_srcStart + _len <= _src.length && _dstStart + _len <= _dst.length, "BYTES_ARRAY_OUT_OF_BOUNDS");
        uint256 srcStartPos;
        uint256 dstStartPos;
        assembly {
            srcStartPos := add(add(_src, 32), _srcStart)
            dstStartPos := add(add(_dst, 32), _dstStart)
        }
        memcpy(srcStartPos, dstStartPos, _len);
    }

    /**
     * Copies bytes from `_src` to `_dst`, starting at position `_dstStart` into `_dst`.
     */
    function copyBytes(bytes memory _src, bytes memory _dst, uint256 _dstStart) internal pure {
        copyBytes(_src, _dst, 0, _dstStart, _src.length);
    }

    /**
     * Calculates keccak256 over a uint256 memory array contents.
     *
     * keccakUint256Array(array) is a more gas-efficient equivalent
     * to keccak256(abi.encodePacked(array)) since copying memory
     * is avoided.
     */
    function keccakUint256Array(uint256[] memory _arr) internal pure returns (bytes32 result) {
        assembly {
            let ptr := add(_arr, 32)
            let len := mul(mload(_arr), 32)
            result := keccak256(ptr, len)
        }
    }

    /**
     * Decreases length of a uint256 memory array `_arr` by the `_trimBy` items.
     */
    function trimUint256Array(uint256[] memory _arr, uint256 _trimBy) internal pure {
        uint256 newLen = _arr.length - _trimBy;
        assembly {
            mstore(_arr, newLen)
        }
    }
}
