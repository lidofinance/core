// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {GIndex, pack, concat, fls} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {BLS12_381} from "contracts/common/lib/BLS.sol";

// As defined in phase0/beacon-chain.md:159
type Slot is uint64;

function unwrap(Slot slot) pure returns (uint64) {
    return Slot.unwrap(slot);
}

function gt(Slot lhs, Slot rhs) pure returns (bool) {
    return lhs.unwrap() > rhs.unwrap();
}

function lt(Slot lhs, Slot rhs) pure returns (bool) {
    return lhs.unwrap() < rhs.unwrap();
}

using {unwrap, lt as <, gt as >} for Slot global;

/*
 Complement to in-contract SSZ library with methods useful for testing
 original:  https://github.com/lidofinance/community-staking-module/blob/7071c2096983a7780a5f147963aaa5405c0badb1/src/lib/SSZ.sol
*/
contract SSZBLSHelpers {
    // As defined in phase0/beacon-chain.md:356
    struct Validator {
        bytes pubkey;
        bytes32 withdrawalCredentials;
        uint64 effectiveBalance;
        bool slashed;
        uint64 activationEligibilityEpoch;
        uint64 activationEpoch;
        uint64 exitEpoch;
        uint64 withdrawableEpoch;
    }

    // As defined in phase0/beacon-chain.md:436
    struct BeaconBlockHeader {
        Slot slot;
        uint64 proposerIndex;
        bytes32 parentRoot;
        bytes32 stateRoot;
        bytes32 bodyRoot;
    }

    function depth(GIndex gIndex) public pure returns (uint256) {
        return fls(gIndex.index());
    }

    // canonical implementation from original SSZ
    function validatorHashTreeRootCalldata(Validator calldata validator) public view returns (bytes32 root) {
        bytes32 pubkeyRoot;

        assembly {
            // In calldata, a dynamic field is encoded as an offset (relative to the start
            // of the struct’s calldata) followed by its contents. The first 32 bytes of
            // `validator` is the offset for `pubkey`. (Remember that `pubkey` is expected
            // to be exactly 48 bytes long.)
            let pubkeyOffset := calldataload(validator)
            // write 32 bytes to 32-64 bytes of scratch space
            // to ensure last 49-64 bytes of pubkey are zeroed
            mstore(0x20, 0)
            // The pubkey’s actual data is encoded at:
            // validator + pubkeyOffset + 32
            // because the first word at that location is the length.
            calldatacopy(0x00, add(validator, add(pubkeyOffset, 32)), 48)
            // Zero the remaining 16 bytes to form a 64‐byte block.
            // (0x30 = 48, so mstore at 0x30 will zero 32 bytes covering addresses 48–79;
            // only bytes 48–63 matter for our 64-byte input.)

            // Call the SHA‑256 precompile (at address 0x02) with the 64-byte block.
            if iszero(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20)) {
                revert(0, 0)
            }
            pubkeyRoot := mload(0x00)
        }

        bytes32[8] memory nodes = [
            pubkeyRoot,
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

    // stupid direct hardcode to build merkle tree, proof and index for validator container for proving pubkey+wc node
    function getValidatorPubkeyWCParentProof(
        Validator calldata validator
    ) public view returns (bytes32[] memory proof, bytes32 root, bytes32 parentNode, GIndex parentIndex) {
        bytes32 pubkeyRoot = BLS12_381.pubkeyRoot(validator.pubkey);

        // Validator struct depth (8 -> 4 -> 2 -> 1)
        bytes32[8] memory ValidatorL1 = [
            pubkeyRoot,
            validator.withdrawalCredentials,
            toLittleEndian(validator.effectiveBalance),
            toLittleEndian(validator.slashed),
            toLittleEndian(validator.activationEligibilityEpoch),
            toLittleEndian(validator.activationEpoch),
            toLittleEndian(validator.exitEpoch),
            toLittleEndian(validator.withdrawableEpoch)
        ];

        bytes32[4] memory ValidatorL2 = [
            BLS12_381.sha256Pair(ValidatorL1[0], ValidatorL1[1]),
            BLS12_381.sha256Pair(ValidatorL1[2], ValidatorL1[3]),
            BLS12_381.sha256Pair(ValidatorL1[4], ValidatorL1[5]),
            BLS12_381.sha256Pair(ValidatorL1[6], ValidatorL1[7])
        ];

        parentNode = ValidatorL2[0];

        bytes32[2] memory ValidatorL3 = [
            BLS12_381.sha256Pair(ValidatorL2[0], ValidatorL2[1]),
            BLS12_381.sha256Pair(ValidatorL2[2], ValidatorL2[3])
        ];

        root = BLS12_381.sha256Pair(ValidatorL3[0], ValidatorL3[1]);
        // validates this hardcode against canonical implementation
        require(root == validatorHashTreeRootCalldata(validator), "root mismatch");

        uint8 proofDepth = 2;
        proof = new bytes32[](proofDepth);
        proof[0] = ValidatorL2[1];
        proof[1] = ValidatorL3[1];

        // This is the parent node of `pubkey` and `withdrawalCredentials` GIndex
        // it's on the start of second level from leaf level
        // it's constant for all validators
        uint256 VALIDATOR_TREE_DEPTH = 2;
        uint256 PARENT_POSITION = 0;
        parentIndex = pack((1 << VALIDATOR_TREE_DEPTH) + PARENT_POSITION, uint8(VALIDATOR_TREE_DEPTH));
        return (proof, root, parentNode, parentIndex);
    }

    // canonical implementation from original SSZ
    function beaconBlockHeaderHashTreeRoot(BeaconBlockHeader memory header) public view returns (bytes32 root) {
        bytes32[8] memory headerNodes = [
            toLittleEndian(header.slot.unwrap()),
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
                let target := headerNodes
                let source := headerNodes
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

    // stupid direct hardcode to build merkle tree, proof and index for validator container for proving pubkey+wc node
    function getBeaconBlockHeaderProof(
        BeaconBlockHeader memory header
    ) public view returns (bytes32[] memory proof, bytes32 root, bytes32 leaf, GIndex index) {
        // stupid hardcode to build tree for block header
        bytes32[8] memory BlockHeaderL1 = [
            toLittleEndian(header.slot.unwrap()),
            toLittleEndian(header.proposerIndex),
            header.parentRoot,
            header.stateRoot, // target leaf at position  3
            header.bodyRoot,
            bytes32(0),
            bytes32(0),
            bytes32(0)
        ];

        bytes32[4] memory BlockHeaderL2 = [
            BLS12_381.sha256Pair(BlockHeaderL1[0], BlockHeaderL1[1]),
            BLS12_381.sha256Pair(BlockHeaderL1[2], BlockHeaderL1[3]),
            BLS12_381.sha256Pair(BlockHeaderL1[4], BlockHeaderL1[5]),
            BLS12_381.sha256Pair(BlockHeaderL1[6], BlockHeaderL1[7])
        ];

        bytes32[2] memory BlockHeaderL3 = [
            BLS12_381.sha256Pair(BlockHeaderL2[0], BlockHeaderL2[1]),
            BLS12_381.sha256Pair(BlockHeaderL2[2], BlockHeaderL2[3])
        ];

        root = BLS12_381.sha256Pair(BlockHeaderL3[0], BlockHeaderL3[1]);
        leaf = header.stateRoot;

        // validates this hardcode against canonical implementation
        require(root == beaconBlockHeaderHashTreeRoot(header), "root mismatch");

        // all siblings on the way from the leaf to the root
        uint256 HEADER_TREE_DEPTH = 3;
        proof = new bytes32[](HEADER_TREE_DEPTH);
        proof[0] = BlockHeaderL1[2];
        proof[1] = BlockHeaderL2[0];
        proof[2] = BlockHeaderL3[1];

        uint256 PARENT_POSITION = 3;
        index = pack((1 << HEADER_TREE_DEPTH) + PARENT_POSITION, uint8(HEADER_TREE_DEPTH));
    }

    // See https://github.com/succinctlabs/telepathy-contracts/blob/5aa4bb7/src/libraries/SimpleSerialize.sol#L17-L28
    function toLittleEndian(uint256 v) public pure returns (bytes32) {
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

    function verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf, GIndex gIndex) public view {
        SSZ.verifyProof(proof, root, leaf, gIndex);
    }

    function toLittleEndian(bool v) public pure returns (bytes32) {
        return bytes32(v ? 1 << 248 : 0);
    }
}
