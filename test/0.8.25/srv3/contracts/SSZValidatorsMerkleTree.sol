// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {GIndex, pack, concat, fls} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {BLS12_381} from "contracts/common/lib/BLS.sol";
import {SSZBLSHelpers} from "../../vaults/predepositGuarantee/contracts/SSZBLSHelpers.sol";

/// Merkle tree implementation
/// NOT gas optimized, for testing proposes only
contract SSZValidatorsMerkleTree is SSZBLSHelpers {
    uint256 public immutable VALIDATORS_DEPTH;

    uint256 public validatorsLeafCount = 0; // Number of leaves in the tree

    uint256 public immutable VALIDATORS_BASE_INDEX;

    mapping(uint256 => bytes32) public nodes;

    /// @notice Initializes the Merkle tree with a given depth and pre-filled nodes so GIndex can closely match CL
    constructor(GIndex validatorsBase) {
        uint256 depthValidators = depth(validatorsBase);

        VALIDATORS_DEPTH = depthValidators;

        // allows to simulate middle part of the tree
        validatorsLeafCount = validatorsBase.index() - (1 << VALIDATORS_DEPTH);

        VALIDATORS_BASE_INDEX = validatorsBase.index();
    }

    // Below methods copied and adapted versions of methods from  ../vaults/SSZMerkleTree.sol

    /// @notice Adds a new leaf to the validators tree
    /// @param validator The leaf value
    /// @return index The index of the added leaf
    function addValidatorsLeaf(SSZBLSHelpers.Validator calldata validator) public returns (uint256) {
        bytes32 leaf = validatorHashTreeRootCalldata(validator);

        require(validatorsLeafCount < (1 << VALIDATORS_DEPTH), "Validators tree is full");

        uint256 gi = VALIDATORS_BASE_INDEX + validatorsLeafCount;
        nodes[gi] = leaf;
        validatorsLeafCount++;

        _updateTree(gi); // Update the Merkle tree structure

        return gi;
    }

    function getStateRoot() public view returns (bytes32) {
        return nodes[1];
    }

    function getValidatorProof(uint256 leafIndex) public view returns (bytes32[] memory) {
        require(leafIndex < validatorsLeafCount, "Invalid leaf index");
        uint256 gi = VALIDATORS_BASE_INDEX + leafIndex;
        return _getMerkleProof(gi);
    }

    /// generalized index for validators[position]
    function getValidatorGeneralizedIndex(uint256 position) public view returns (GIndex) {
        require(position < (1 << VALIDATORS_DEPTH), "Invalid position");
        uint256 gi = VALIDATORS_BASE_INDEX + position;
        return pack(gi, uint8(VALIDATORS_DEPTH));
    }

    /// @notice Computes and returns the Merkle proof for a given *global* index
    function _getMerkleProof(uint256 index) internal view returns (bytes32[] memory) {
        // Use fls(index) to get actual tree depth, not TREE_DEPTH which may be incorrect
        // for indices that overflow to next power of 2
        // floor(log2)
        uint256 actualDepth = fls(index);
        bytes32[] memory proof = new bytes32[](actualDepth);

        for (uint256 i = 0; i < actualDepth; ++i) {
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
