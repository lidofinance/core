// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

library Memory {
    /// @notice Insufficient length provided for memory allocation
    error AllocationLengthZero();
    /// @notice Source offset exceeds buffer length
    error InvalidSourceOffset();
    /// @notice Destination offset exceeds buffer length
    error InvalidDestinationOffset();
    /// @notice Copy source length exceeds buffer bounds
    error CopySourceOutOfBounds();
    /// @notice Copy destination length exceeds buffer bounds
    error CopyDestinationOutOfBounds();
    /// @notice Requested slice exceeds data bounds
    error SliceOutOfBounds();

    /**
     * @notice Allocates a new bytes array in memory
     * @param length The length of the array to allocate
     * @return result The allocated bytes array
     */
    function alloc(uint256 length) internal pure returns (bytes memory result) {
        if (length == 0) revert AllocationLengthZero();

        assembly {
            result := mload(0x40)
            mstore(result, length)
            mstore(0x40, add(add(result, 0x20), length))
        }
    }

    /**
     * @notice Copies bytes from one memory location to another
     * @param src Source bytes array
     * @param dst Destination bytes array
     * @param srcOffset Offset in source array
     * @param dstOffset Offset in destination array
     * @param length Number of bytes to copy
     */
    function copy(
        bytes memory src,
        bytes memory dst,
        uint256 srcOffset,
        uint256 dstOffset,
        uint256 length
    ) internal pure {
        if (srcOffset >= src.length) revert InvalidSourceOffset();
        if (dstOffset >= dst.length) revert InvalidDestinationOffset();
        if (src.length < srcOffset + length) revert CopySourceOutOfBounds();
        if (dst.length < dstOffset + length) revert CopyDestinationOutOfBounds();

        assembly {
            let srcPtr := add(add(src, 0x20), srcOffset)
            let dstPtr := add(add(dst, 0x20), dstOffset)
            mcopy(dstPtr, srcPtr, length)
        }
    }

    /**
     * @notice Extracts a slice from a bytes array
     * @param data The source bytes array
     * @param start The starting index of the slice
     * @param length The length of the slice
     * @return result The extracted slice
     */
    function slice(bytes memory data, uint256 start, uint256 length) internal pure returns (bytes memory result) {
        if (data.length < start + length) revert SliceOutOfBounds();

        result = new bytes(length);
        assembly {
            let src := add(add(data, 0x20), start)
            let dest := add(result, 0x20)
            mcopy(dest, src, length)
        }
    }
}
