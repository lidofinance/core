// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {CLProofVerifier, Validator, SSZ} from "contracts/0.8.25/vaults/predeposit_guarantee/CLProofVerifier.sol";

import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";

contract CLProofVerifier__Harness is CLProofVerifier {
    // Store the leaves of the Merkle tree.
    bytes32[] public leaves;

    /**
     * @notice Adds a new leaf to the tree.
     * @param leaf The new leaf (for example, the keccak256 hash of some data).
     * @return The index of the new leaf in the `leaves` array.
     */
    function TEST_addLeaf(bytes32 leaf) public returns (uint256) {
        leaves.push(leaf);
        return leaves.length - 1;
    }

    function TEST_lastIndex() public view returns (uint256) {
        return leaves.length - 1;
    }

    /**
     * @notice Adds a new validator leaf to the tree.
     * @param _validator the new validator container to add to merkle tree
     * @return The index of the new leaf in the `leaves` array.
     */
    function TEST_addValidatorLeaf(Validator calldata _validator) public returns (uint256) {
        return TEST_addLeaf(SSZ.hashTreeRoot(_validator));
    }

    /**
     * @notice Generates a Merkle proof for the leaf at the given index.
     *         The proof is an array of sibling hashes (one per level) using sorted pair hashing.
     * @dev This implementation builds the tree on chain. For an odd number of nodes at any level,
     *      the last node is paired with itself.
     * @param index The index of the target leaf in the `leaves` array.
     * @return proof An array of sibling nodes that form the proof.
     */
    function TEST_getProof(uint256 index) public view returns (bytes32[] memory proof) {
        require(index < leaves.length, "Index out of bounds");

        // Compute the number of levels in the tree.
        // For a single leaf, the tree height is 1.
        uint256 totalLevels = 1;
        uint256 len = leaves.length;
        while (len > 1) {
            totalLevels++;
            len = (len + 1) / 2;
        }
        // The proof will have one element per level except the root.
        proof = new bytes32[](totalLevels - 1);

        bytes32[] memory currentLevel = leaves;
        uint256 proofIndex = 0;
        uint256 currentIndex = index;

        // Traverse up the tree until we reach the root.
        while (currentLevel.length > 1) {
            uint256 siblingIndex;
            if (currentIndex % 2 == 0) {
                siblingIndex = currentIndex + 1;
            } else {
                siblingIndex = currentIndex - 1;
            }
            // If the sibling exists, use it; otherwise, duplicate the current node.
            if (siblingIndex < currentLevel.length) {
                proof[proofIndex] = currentLevel[siblingIndex];
            } else {
                proof[proofIndex] = currentLevel[currentIndex];
            }
            proofIndex++;

            // Build the next level using sorted pair hashing.
            uint256 nextLevelLength = (currentLevel.length + 1) / 2;
            bytes32[] memory nextLevel = new bytes32[](nextLevelLength);
            for (uint256 i = 0; i < currentLevel.length; i += 2) {
                if (i + 1 < currentLevel.length) {
                    nextLevel[i / 2] = _hashPair(currentLevel[i], currentLevel[i + 1]);
                } else {
                    nextLevel[i / 2] = _hashPair(currentLevel[i], currentLevel[i]);
                }
            }
            currentIndex = currentIndex / 2;
            currentLevel = nextLevel;
        }
    }

    /**
     * @dev Internal function to compute the Merkle root from an array of leaves.
     *      Uses sorted pair hashing at each level. If the number of nodes is odd, the last node is paired with itself.
     * @param _leaves The array of leaves.
     * @return The Merkle tree root.
     */
    function _computeMerkleRoot(bytes32[] memory _leaves) internal pure returns (bytes32) {
        if (_leaves.length == 0) {
            return bytes32(0);
        }
        bytes32[] memory currentLevel = _leaves;
        while (currentLevel.length > 1) {
            uint256 nextLevelLength = (currentLevel.length + 1) / 2;
            bytes32[] memory nextLevel = new bytes32[](nextLevelLength);
            for (uint256 i = 0; i < currentLevel.length; i += 2) {
                if (i + 1 < currentLevel.length) {
                    nextLevel[i / 2] = _hashPair(currentLevel[i], currentLevel[i + 1]);
                } else {
                    nextLevel[i / 2] = _hashPair(currentLevel[i], currentLevel[i]);
                }
            }
            currentLevel = nextLevel;
        }
        return currentLevel[0];
    }

    /**
     * @dev Internal function to hash a pair of nodes in sorted order.
     *      This is identical to the hashing used by OpenZeppelin's MerkleProof.
     * @param a First hash.
     * @param b Second hash.
     * @return The hash of the sorted pair.
     */
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // override for
    function _getParentBlockRoot(uint64) internal view override returns (bytes32) {
        return _computeMerkleRoot(leaves);
    }

    function TEST_validateWCProof(
        Validator calldata _validator,
        bytes32[] calldata _proof,
        uint64 beaconBlockTimestamp
    ) public view {
        require(_validator.withdrawalCredentials == super._validateWCProof(_validator, _proof, beaconBlockTimestamp));
    }
}
