// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex} from "./GIndex.sol";

/*
 Cut and modified version of SSZ library from CSM only has methods for merkilized SSZ proof validation
 original:  https://github.com/lidofinance/community-staking-module/blob/7071c2096983a7780a5f147963aaa5405c0badb1/src/lib/SSZ.sol
*/
library SSZ {
    error BranchHasMissingItem();
    error BranchHasExtraItem();
    error InvalidProof();
    error InvalidPubkeyLength();

    /// @notice Modified version of `verify` from Solady `MerkleProofLib` to support generalized indices and sha256 precompile.
    /// @dev Reverts if `leaf` doesn't exist in the Merkle tree with `root`, given `proof`.
    function verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf, GIndex gIndex) internal view {
        uint256 index = gIndex.index();
        /// @solidity memory-safe-assembly
        assembly {
            // Check if `proof` is empty.
            if iszero(proof.length) {
                // revert InvalidProof()
                mstore(0x00, 0x09bde339)
                revert(0x1c, 0x04)
            }
            // Left shift by 5 is equivalent to multiplying by 0x20.
            let end := add(proof.offset, shl(5, proof.length))
            // Initialize `offset` to the offset of `proof` in the calldata.
            let offset := proof.offset
            // Iterate over proof elements to compute root hash.
            // prettier-ignore
            for { } 1 { } {
                // Slot of `leaf` in scratch space.
                // If the condition is true: 0x20, otherwise: 0x00.
                let scratch := shl(5, and(index, 1))
                index := shr(1, index)
                if iszero(index) {
                    // revert BranchHasExtraItem()
                    mstore(0x00, 0x5849603f)
                    // 0x1c = 28 => offset in 32-byte word of a slot 0x00
                    revert(0x1c, 0x04)
                }
                // Store elements to hash contiguously in scratch space.
                // Scratch space is 64 bytes (0x00 - 0x3f) and both elements are 32 bytes.
                mstore(scratch, leaf)
                mstore(xor(scratch, 0x20), calldataload(offset))
                // Call sha256 precompile.
                let result := staticcall(
                    gas(),
                    0x02,
                    0x00,
                    0x40,
                    0x00,
                    0x20
                )

                if iszero(result) {
                    // Precompile returns no data on OutOfGas error.
                    revert(0, 0)
                }

                // Reuse `leaf` to store the hash to reduce stack operations.
                leaf := mload(0x00)
                offset := add(offset, 0x20)
                if iszero(lt(offset, end)) {
                    break
                }
            }

            if iszero(eq(index, 1)) {
                // revert BranchHasMissingItem()
                mstore(0x00, 0x1b6661c3)
                revert(0x1c, 0x04)
            }

            if iszero(eq(leaf, root)) {
                // revert InvalidProof()
                mstore(0x00, 0x09bde339)
                revert(0x1c, 0x04)
            }
        }
    }

    /// @notice Extracted part from `verifyProof` for hashing two leaves
    /// @dev Combines 2 bytes32 in 64 bytes input for sha256 precompile
    function sha256Pair(bytes32 left, bytes32 right) internal view returns (bytes32 result) {
        /// @solidity memory-safe-assembly
        assembly {
            // Store `left` at memory position 0x00
            mstore(0x00, left)
            // Store `right` at memory position 0x20
            mstore(0x20, right)

            // Call SHA-256 precompile (0x02) with 64-byte input at memory 0x00
            let success := staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20)
            if iszero(success) {
                revert(0, 0)
            }

            // Load the resulting hash from memory
            result := mload(0x00)
        }
    }

    /// @notice Extracted and modified part from `hashTreeRoot` for hashing validator pubkey from calldata
    /// @dev Reverts if `pubkey` length is not 48
    function pubkeyRoot(bytes calldata pubkey) internal view returns (bytes32 _pubkeyRoot) {
        if (pubkey.length != 48) revert InvalidPubkeyLength();

        /// @solidity memory-safe-assembly
        assembly {
            // Copy 48 bytes of `pubkey` to memory at 0x00
            calldatacopy(0x00, pubkey.offset, 48)

            // Zero the remaining 16 bytes to form a 64-byte input block
            mstore(0x30, 0)

            // Call the SHA-256 precompile (0x02) with the 64-byte input
            if iszero(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20)) {
                revert(0, 0)
            }

            // Load the resulting SHA-256 hash
            _pubkeyRoot := mload(0x00)
        }
    }
}
