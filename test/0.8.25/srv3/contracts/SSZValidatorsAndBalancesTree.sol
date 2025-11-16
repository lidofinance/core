// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {GIndex, pack, concat, fls} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {BLS12_381} from "contracts/common/lib/BLS.sol";
import {SSZBLSHelpers} from "../../vaults/predepositGuarantee/contracts/SSZBLSHelpers.sol";
import "hardhat/console.sol";

/// Merkle tree Implementation that aligns with CL implementation
/// NOT gas optimized, for testing proposes only
contract SSZValidatorsAndBalancesMerkleTree is SSZBLSHelpers {
    // Separate depths: validators/balances have VALIDATOR_REGISTRY_LIMIT=2^40 (depth=47)
    // pending_deposits has PENDING_DEPOSITS_LIMIT=2^27 (depth=34)
    uint256 public immutable VALIDATORS_BALANCES_DEPTH;
    uint256 public immutable PENDING_DEPOSITS_DEPTH;

    uint256 public validatorsLeafCount = 0; // Number of leaves in the tree
    uint256 public balancesLeafCount = 0;
    uint256 public pendingDepositsLeafCount = 0;

    uint256 public immutable VALIDATORS_BASE_INDEX;
    uint256 public immutable BALANCES_BASE_INDEX;
    uint256 public immutable PENDING_DEPOSITS_BASE_INDEX;

    mapping(uint256 => bytes32) public nodes;

    struct PendingDeposit {
        bytes pubkey; // 0x00, offset(pubkey)
        bytes32 withdrawalCredentials; //0x20
        uint64 amount; // 0x40
        bytes signature; //0x60 offset(96)
        uint32 slot; //0x80
    }

    /// @notice Initializes the Merkle tree with a given depth and pre-filled nodes so GIndex can closely match CL
    constructor(GIndex validatorsBase, GIndex balancesBase, GIndex pendingDepositsBase) {
        uint256 depthValidators = depth(validatorsBase);
        uint256 depthBalances = depth(balancesBase);
        uint256 depthPending = depth(pendingDepositsBase);

        require(depthValidators == depthBalances, "Depth mismatch: validators vs balances");
        // Note: pending_deposits has different depth (34) than validators/balances (47)
        // because PENDING_DEPOSITS_LIMIT=2^27 vs VALIDATOR_REGISTRY_LIMIT=2^40

        VALIDATORS_BALANCES_DEPTH = depthValidators;
        PENDING_DEPOSITS_DEPTH = depthPending;

        // allows to simulate middle part of the tree
        validatorsLeafCount = validatorsBase.index() - (1 << VALIDATORS_BALANCES_DEPTH);
        balancesLeafCount = balancesBase.index() - (1 << VALIDATORS_BALANCES_DEPTH);
        pendingDepositsLeafCount = pendingDepositsBase.index() - (1 << PENDING_DEPOSITS_DEPTH);

        VALIDATORS_BASE_INDEX = validatorsBase.index();
        BALANCES_BASE_INDEX = balancesBase.index();
        PENDING_DEPOSITS_BASE_INDEX = pendingDepositsBase.index();
    }

    /// Add a new leaf to the balances tree
    /// @param balanceGwei The leaf value
    function addBalancesLeaf(uint64 balanceGwei) public returns (uint256) {
        require(balancesLeafCount < (1 << VALIDATORS_BALANCES_DEPTH), "Balances tree is full");
        bytes32 leaf = SSZ.toLittleEndian(balanceGwei);

        uint256 gi = BALANCES_BASE_INDEX + balancesLeafCount;
        nodes[gi] = leaf;
        balancesLeafCount++;
        _updateTree(gi); // Update the Merkle tree structure

        return gi;
    }

    function addPendingDepositLeaf(PendingDeposit calldata pendingDeposit) public returns (uint256) {
        bytes32 leaf = _pendingDepositHashTreeRootCalldata(pendingDeposit);
        require(pendingDepositsLeafCount < (1 << PENDING_DEPOSITS_DEPTH), "Pending deposits tree is full");
        uint256 gi = PENDING_DEPOSITS_BASE_INDEX + pendingDepositsLeafCount;
        nodes[gi] = leaf;
        pendingDepositsLeafCount++;
        _updateTree(gi);
        return gi;
    }

    function _pendingDepositHashTreeRootCalldata(
        PendingDeposit calldata pendingDeposit
    ) internal view returns (bytes32 root) {
        // prepare pubkeyRoot
        bytes32 pubkeyRoot;
        assembly {
            // reading 32 bytes, offset for pubkey
            let pubkeyOffset := calldataload(pendingDeposit)
            // write offset
            mstore(0x20, 0)
            calldatacopy(0x00, add(pendingDeposit, add(pubkeyOffset, 32)), 48)

            if iszero(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20)) {
                revert(0, 0)
            }

            pubkeyRoot := mload(0x00)
        }

        // 0x60
        bytes32 signatureRoot;
        assembly {
            // Read offset to signature tail
            let signatureOffset := calldataload(add(pendingDeposit, 96))
            let sigLen := calldataload(add(add(pendingDeposit, signatureOffset), 0x00))

            if iszero(eq(sigLen, 96)) {
                revert(0, 0)
            }

            // free memory pointer
            let ptr := mload(0x40)

            // signature is 96 bytes
            // skip 32 bytes of length, read 96 bytes
            // write to 0x00..0x5F (0 up to 95 byte)
            calldatacopy(ptr, add(pendingDeposit, add(signatureOffset, 32)), 96)

            // leafs: chunk 0, chunk 1, chunk 2, chunk 3
            // chunk 0: ptr..ptr + 31
            // chunk 1: ptr + 32..ptr + 63
            // chunk 2: ptr + 64..ptr + 95
            // chunk 3: ptr + 96..ptr + 127
            // write zero in chunk 3
            mstore(add(ptr, 96), 0)

            // make SHA256  for  first 32 bytes
            // building root
            // L0 = sha256(chunk 0 || chunk 1)
            // L1 = sha256(chunk 2 || chunk 3)
            // root = sha256(L0 || L1)
            // read ptr..ptr + 0x40  (ptr..ptr + 63 bytes)
            // write from ptr + 0x80..ptr+0x9F (ptr + 128 bytes..ptr + 159 bytes) 32 bytes
            if iszero(staticcall(gas(), 0x02, ptr, 0x40, add(ptr, 0x80), 0x20)) {
                revert(0, 0)
            }

            // L1 = sha256(chunk 2 || chunk 3)
            // read: read ptr+64..ptr+127]
            // write: ptr+0xA0..ptr+0xBF
            if iszero(staticcall(gas(), 0x02, add(ptr, 0x40), 0x40, add(ptr, 0xA0), 0x20)) {
                revert(0, 0)
            }

            // sha256(L0|L1)
            // 32 bytes from add(ptr, 0x80)
            mstore(ptr, mload(add(ptr, 0x80)))
            // next 32 bytes
            mstore(add(ptr, 0x20), mload(add(ptr, 0xA0)))

            if iszero(staticcall(gas(), 0x02, ptr, 0x40, ptr, 0x20)) {
                revert(0, 0)
            }

            signatureRoot := mload(ptr)
            // move free memory pointer
            mstore(0x40, add(ptr, 0xC0))
        }

        bytes32[8] memory treeNodes = [
            pubkeyRoot,
            pendingDeposit.withdrawalCredentials,
            toLittleEndian(pendingDeposit.amount),
            signatureRoot,
            toLittleEndian(pendingDeposit.slot),
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
                let target := treeNodes
                let source := treeNodes
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

    // Below methods copied and adapted versions of methods from  ../vaults/SSZMerkleTree.sol

    /// @notice Adds a new leaf to the validators tree
    /// @param validator The leaf value
    /// @return index The index of the added leaf
    function addValidatorsLeaf(SSZBLSHelpers.Validator calldata validator) public returns (uint256) {
        bytes32 leaf = validatorHashTreeRootCalldata(validator);

        require(validatorsLeafCount < (1 << VALIDATORS_BALANCES_DEPTH), "Validators tree is full");

        uint256 gi = VALIDATORS_BASE_INDEX + validatorsLeafCount;
        nodes[gi] = leaf;
        validatorsLeafCount++;

        _updateTree(gi); // Update the Merkle tree structure

        return gi;
    }

    function getStateRoot() public view returns (bytes32) {
        return nodes[1]; // корень глобального дерева
    }

    function getValidatorProof(uint256 leafIndex) public view returns (bytes32[] memory) {
        require(leafIndex < validatorsLeafCount, "Invalid leaf index");
        uint256 gi = VALIDATORS_BASE_INDEX + leafIndex;
        return _getMerkleProof(gi);
    }

    /// @notice Пруф для balances[leafIndex] относительно balances_root.
    function getBalanceProof(uint256 leafIndex) public view returns (bytes32[] memory) {
        require(leafIndex < balancesLeafCount, "Invalid leaf index");
        uint256 gi = BALANCES_BASE_INDEX + leafIndex;
        return _getMerkleProof(gi);
    }

    function getPendingDepositProof(uint256 leafIndex) public view returns (bytes32[] memory) {
        require(leafIndex < pendingDepositsLeafCount, "Invalid leaf index");
        uint256 gi = PENDING_DEPOSITS_BASE_INDEX + leafIndex;
        return _getMerkleProof(gi);
    }

    /// generalized index for validators[position]
    function getValidatorGeneralizedIndex(uint256 position) public view returns (GIndex) {
        require(position < (1 << VALIDATORS_BALANCES_DEPTH), "Invalid position");
        uint256 gi = VALIDATORS_BASE_INDEX + position;
        return pack(gi, uint8(VALIDATORS_BALANCES_DEPTH));
    }

    /// generalized index for balances[position]
    function getBalanceGeneralizedIndex(uint256 position) public view returns (GIndex) {
        require(position < (1 << VALIDATORS_BALANCES_DEPTH), "Invalid position");
        uint256 gi = BALANCES_BASE_INDEX + position;
        return pack(gi, uint8(VALIDATORS_BALANCES_DEPTH));
    }

    /// generalized index for pending_deposits[position]
    function getPendingDepositGeneralizedIndex(uint256 position) public view returns (GIndex) {
        require(position < (1 << PENDING_DEPOSITS_DEPTH), "Invalid position");
        uint256 gi = PENDING_DEPOSITS_BASE_INDEX + position;
        return pack(gi, uint8(PENDING_DEPOSITS_DEPTH));
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
