// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {pack} from "contracts/0.8.25/lib/GIndex.sol";

import {CLProofVerifier, Validator, SSZ, ValidatorWitness, GIndex} from "contracts/0.8.25/vaults/predeposit_guarantee/CLProofVerifier.sol";

contract CLProofVerifier__Harness is CLProofVerifier {
    bytes32 public MOCK_ROOT;

    constructor(GIndex _gIFirstValidator) CLProofVerifier(_gIFirstValidator) {}

    function setRoot(bytes32 _root) public {
        MOCK_ROOT = _root;
    }

    function _getParentBlockRoot(uint64) internal view override returns (bytes32) {
        return MOCK_ROOT;
    }

    function TEST_validateWCProof(ValidatorWitness calldata _witness) public view {
        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.beaconBlockTimestamp),
            leaf: SSZ.hashTreeRoot(_witness.validator),
            gIndex: _getValidatorGI(_witness.validatorIndex)
        });
    }
}

contract SSZMerkleTree {
    uint256 public constant TREE_DEPTH = 32; // Adjustable tree depth (16 leaves max)
    uint256 public leafCount = 0; // Number of leaves in the tree
    mapping(uint256 => bytes32) public nodes; // Merkle tree nodes mapping

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
    function getGeneralizedIndex(uint256 position) public pure returns (GIndex) {
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

    function addValidatorLeaf(Validator calldata validator) public returns (uint256) {
        return addLeaf(SSZ.hashTreeRoot(validator));
    }
}
