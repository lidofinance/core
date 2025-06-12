// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {BeaconBlockHeader, Validator} from "./BeaconTypes.sol";
import {GIndex} from "./GIndex.sol";

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

/*
 SSZ library from CSM
 original: https://github.com/lidofinance/community-staking-module/blob/7071c2096983a7780a5f147963aaa5405c0badb1/src/lib/SSZ.sol
*/
library SSZ {
    error BranchHasMissingItem();
    error BranchHasExtraItem();
    error InvalidProof();
    error InvalidPubkeyLength();
    error InvalidBlockHeader();

    /// @notice Domain for deposit message signing
    /// @dev per https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#domain-types
    bytes4 internal constant DOMAIN_DEPOSIT_TYPE = 0x03000000;

    /// @notice calculation of deposit domain based on fork version
    /// @dev per https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_domain
    function computeDepositDomain(bytes4 genesisForkVersion) internal view returns (bytes32 depositDomain) {
        bytes32 forkDataRoot = sha256Pair(genesisForkVersion, bytes32(0));
        depositDomain = DOMAIN_DEPOSIT_TYPE | (forkDataRoot >> 32);
    }

    /// @notice calculation of signing root for deposit message
    /// @dev per https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_signing_root
    /// @dev not be confused with `depositDataRoot`, used for verifying BLS deposit signature
    function depositMessageSigningRoot(
        IStakingVault.Deposit calldata deposit,
        bytes32 withdrawalCredentials,
        bytes32 depositDomain
    ) internal view returns (bytes32 root) {
        root = sha256Pair(
            // merkle root of the deposit message
            sha256Pair(
                sha256Pair(
                    // pubkey must be hashed to be used as leaf
                    pubkeyRoot(deposit.pubkey),
                    withdrawalCredentials
                ),
                sha256Pair(
                    toLittleEndian(deposit.amount / 1 gwei),
                    // filler to make leaf count power of 2
                    bytes32(0)
                )
            ),
            depositDomain
        );
    }

    /// @notice SSZ hash tree root of a CL Beacon Block Header
    /// @param header Beacon Block Header container struct
    function hashTreeRoot(BeaconBlockHeader memory header) internal view returns (bytes32 root) {
        bytes32[8] memory nodes = [
            toLittleEndian(header.slot),
            toLittleEndian(header.proposerIndex),
            header.parentRoot,
            header.stateRoot,
            header.bodyRoot,
            bytes32(0),
            bytes32(0),
            bytes32(0)
        ];

        /// @solidity memory-safe-assembly
        assembly {
            // Count of nodes to hash
            let count := 8

            // Loop over levels
            // prettier-ignore
            for { } 1 { } {
                // Loop over nodes at the given depth

                // Initialize `offset` to the offset of `proof` elements in memory.
                let target := nodes
                let source := nodes
                let end := add(source, shl(5, count))

                // prettier-ignore
                for { } 1 { } {
                    // Read next two hashes to hash
                    mcopy(0x00, source, 0x40)

                    // Call sha256 precompile
                    let result := staticcall(
                        gas(),
                        0x02,
                        0x00,
                        0x40,
                        0x00,
                        0x20
                    )

                    if iszero(result) {
                        // Precompiles returns no data on OutOfGas error.
                        revert(0, 0)
                    }

                    // Store the resulting hash at the target location
                    mstore(target, mload(0x00))

                    // Advance the pointers
                    target := add(target, 0x20)
                    source := add(source, 0x40)

                    if iszero(lt(source, end)) {
                        break
                    }
                }

                count := shr(1, count)
                if eq(count, 1) {
                    root := mload(0x00)
                    break
                }
            }
        }
    }

    /// @notice SSZ hash tree root of a CL validator container
    /// @param validator Validator container struct
    function hashTreeRoot(Validator memory validator) internal view returns (bytes32 root) {
        bytes32 _pubkeyRoot;

        assembly {
            // Dynamic data types such as bytes are stored at the specified offset.
            let offset := mload(validator)
            // Copy the pubkey to the scratch space.
            mcopy(0x00, add(offset, 32), 48)
            // Clear the last 16 bytes.
            mcopy(48, 0x60, 16)
            // Call sha256 precompile.
            let result := staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20)

            if iszero(result) {
                // Precompiles returns no data on OutOfGas error.
                revert(0, 0)
            }

            _pubkeyRoot := mload(0x00)
        }

        bytes32[8] memory nodes = [
            _pubkeyRoot,
            validator.withdrawalCredentials,
            toLittleEndian(validator.effectiveBalance),
            toLittleEndian(validator.slashed),
            toLittleEndian(validator.activationEligibilityEpoch),
            toLittleEndian(validator.activationEpoch),
            toLittleEndian(validator.exitEpoch),
            toLittleEndian(validator.withdrawableEpoch)
        ];

        /// @solidity memory-safe-assembly
        assembly {
            // Count of nodes to hash
            let count := 8

            // Loop over levels
            // prettier-ignore
            for { } 1 { } {
                // Loop over nodes at the given depth

                // Initialize `offset` to the offset of `proof` elements in memory.
                let target := nodes
                let source := nodes
                let end := add(source, shl(5, count))

                // prettier-ignore
                for { } 1 { } {
                    // Read next two hashes to hash
                    mcopy(0x00, source, 0x40)

                    // Call sha256 precompile
                    let result := staticcall(
                        gas(),
                        0x02,
                        0x00,
                        0x40,
                        0x00,
                        0x20
                    )

                    if iszero(result) {
                        // Precompiles returns no data on OutOfGas error.
                        revert(0, 0)
                    }

                    // Store the resulting hash at the target location
                    mstore(target, mload(0x00))

                    // Advance the pointers
                    target := add(target, 0x20)
                    source := add(source, 0x40)

                    if iszero(lt(source, end)) {
                        break
                    }
                }

                count := shr(1, count)
                if eq(count, 1) {
                    root := mload(0x00)
                    break
                }
            }
        }
    }

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
                // load next proof from calldata to the scratch space at 0x00 or 0x20
                // xor() acts as if
                mstore(xor(scratch, 0x20), calldataload(offset))
                // Call sha256 precompile.
                let result := staticcall(
                    gas(),
                    0x02, // SHA-256 precompile
                    0x00, // input from scratch space from 0x00
                    0x40, // length is 2 leafs of 32 bytes each
                    0x00, // output back to scratch space at 0x00
                    0x20  // length of the output is 32 bytes
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
            // write 32 bytes to 32-64 bytes of scratch space
            // to ensure last 49-64 bytes of pubkey are zeroed
            mstore(0x20, 0)
            // Copy 48 bytes of `pubkey` to start of scratch space
            calldatacopy(0x00, pubkey.offset, 48)

            // Call the SHA-256 precompile (0x02) with the 64-byte input
            if iszero(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20)) {
                revert(0, 0)
            }

            // Load the resulting SHA-256 hash
            _pubkeyRoot := mload(0x00)
        }
    }

    // See https://github.com/succinctlabs/telepathy-contracts/blob/5aa4bb7/src/libraries/SimpleSerialize.sol#L17-L28
    function toLittleEndian(uint256 v) internal pure returns (bytes32) {
        v =
            ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8) |
            ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        v =
            ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16) |
            ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        v =
            ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32) |
            ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        v =
            ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64) |
            ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        v = (v >> 128) | (v << 128);
        return bytes32(v);
    }

    function toLittleEndian(bool v) internal pure returns (bytes32) {
        return bytes32(v ? 1 << 248 : 0);
    }
}
