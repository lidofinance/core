// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {GIndex, pack, concat} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";

import {SSZBLSHelpers} from "./SSZBLSHelpers.sol";

/// Merkle tree Implementation that aligns with CL implementation
/// NOT gas optimized, for testing proposes only
contract SSZMerkleTree is SSZBLSHelpers {
    uint256 public immutable TREE_DEPTH; // Adjustable tree depth
    uint256 public leafCount = 0; // Number of leaves in the tree
    mapping(uint256 => bytes32) public nodes; // Merkle tree nodes mapping

    /// @notice Initializes the Merkle tree with a given depth and pre-filled nodes so GIndex can closesly match CL
    constructor(GIndex base) {
        TREE_DEPTH = depth(base);
        // allows to simulate middle part of the tree
        leafCount = base.index() - (1 << TREE_DEPTH);
    }

    /// @notice Adds a new leaf to the tree
    /// @param leaf The leaf value (hashed data)
    /// @return index The index of the added leaf
    function addLeaf(bytes32 leaf) public returns (uint256) {
        require(leafCount < (1 << TREE_DEPTH), "Tree is full");

        uint256 index = (1 << TREE_DEPTH) + leafCount; // Compute SSZ generalized index
        nodes[index] = leaf;
        leafCount++;

        _updateTree(index); // Update the Merkle tree structure

        return index;
    }

    /// @notice Computes the Merkle root of the tree
    /// @return root The computed root hash
    function getMerkleRoot() public view returns (bytes32) {
        return nodes[1]; // The root of the tree
    }

    /// @notice Computes and returns the Merkle proof for a given leaf index
    /// @param leafIndex The index of the leaf in the tree
    /// @return proof The array of proof hashes
    function getMerkleProof(uint256 leafIndex) public view returns (bytes32[] memory) {
        require(leafIndex < leafCount, "Invalid leaf index");

        uint256 index = (1 << TREE_DEPTH) + leafIndex;
        bytes32[] memory proof = new bytes32[](TREE_DEPTH);

        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            uint256 siblingIndex = index % 2 == 0 ? index + 1 : index - 1;
            proof[i] = nodes[siblingIndex];
            index /= 2;
        }
        return proof;
    }

    /// @notice Returns the SSZ generalized index of a given leaf position
    /// @param position The position of the leaf (0-based)
    /// @return generalizedIndex The SSZ generalized index
    function getGeneralizedIndex(uint256 position) public view returns (GIndex) {
        require(position < (1 << TREE_DEPTH), "Invalid position");

        return pack((1 << TREE_DEPTH) + position, uint8(TREE_DEPTH));
    }

    /// @dev Updates the tree after adding a leaf
    /// @param index The index of the new leaf
    function _updateTree(uint256 index) internal {
        while (index > 1) {
            uint256 parentIndex = index / 2;
            uint256 siblingIndex = index % 2 == 0 ? index + 1 : index - 1;

            bytes32 left = nodes[index % 2 == 0 ? index : siblingIndex];
            bytes32 right = nodes[index % 2 == 0 ? siblingIndex : index];

            nodes[parentIndex] = sha256(abi.encodePacked(left, right));

            index = parentIndex;
        }
    }

    function addValidatorLeaf(SSZBLSHelpers.Validator calldata validator) public returns (uint256) {
        return addLeaf(validatorHashTreeRootCalldata(validator));
    }
}
