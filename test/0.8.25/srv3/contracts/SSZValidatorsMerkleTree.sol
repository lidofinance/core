// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {GIndex, pack, concat, fls} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {BLS12_381} from "contracts/common/lib/BLS.sol";
import {SSZBLSHelpers} from "../../vaults/predepositGuarantee/contracts/SSZBLSHelpers.sol";

/// Merkle tree implementation aligned with CL state tree structure
/// NOT gas optimized, for testing purposes only
contract SSZValidatorsMerkleTree is SSZBLSHelpers {
    uint256 public immutable TREE_DEPTH;

    uint256 public leafCount = 0;

    uint256 public immutable VALIDATORS_BASE_INDEX;

    mapping(uint256 => bytes32) public nodes;

    /// @notice Initializes the Merkle tree with a given depth and pre-filled nodes so GIndex can closely match CL
    constructor(GIndex validatorsBase) {
        TREE_DEPTH = depth(validatorsBase);

        // offset to the start of validators field in the state tree
        leafCount = validatorsBase.index() - (1 << TREE_DEPTH);

        VALIDATORS_BASE_INDEX = validatorsBase.index();
    }

    /// @notice Adds a new leaf to the validators tree
    /// @param validator The leaf value
    /// @return index The index of the added leaf
    function addValidatorsLeaf(SSZBLSHelpers.Validator calldata validator) public returns (uint256) {
        bytes32 leaf = validatorHashTreeRootCalldata(validator);

        require(leafCount < (1 << TREE_DEPTH), "Tree is full");

        uint256 gi = (1 << TREE_DEPTH) + leafCount;
        nodes[gi] = leaf;
        leafCount++;

        _updateTree(gi);

        return gi;
    }

    function getStateRoot() public view returns (bytes32) {
        return nodes[1];
    }

    function getValidatorProof(uint256 leafIndex) public view returns (bytes32[] memory) {
        require(leafIndex < leafCount, "Invalid leaf index");
        uint256 gi = (1 << TREE_DEPTH) + leafIndex;
        return _getMerkleProof(gi);
    }

    /// generalized index for validators[position]
    function getValidatorGeneralizedIndex(uint256 position) public view returns (GIndex) {
        require(position < (1 << TREE_DEPTH), "Invalid position");
        uint256 gi = (1 << TREE_DEPTH) + position;
        return pack(gi, uint8(TREE_DEPTH));
    }

    /// @notice Computes and returns the Merkle proof for a given *global* index
    function _getMerkleProof(uint256 index) internal view returns (bytes32[] memory) {
        bytes32[] memory proof = new bytes32[](TREE_DEPTH);

        for (uint256 i = 0; i < TREE_DEPTH; ++i) {
            uint256 siblingIndex = index % 2 == 0 ? index + 1 : index - 1;
            proof[i] = nodes[siblingIndex];
            index /= 2;
        }

        return proof;
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
}
