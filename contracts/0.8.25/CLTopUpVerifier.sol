// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {GIndex, pack, concat} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {BLS12_381} from "contracts/common/lib/BLS.sol";
import {BeaconRootData, ValidatorWitness, BalanceWitness, PendingWitness} from "../common/interfaces/TopUpWitness.sol";

/**
 * @title CLTopUpVerifier
 * @author Lido
 * @notice
 *
 * Smart contract verifying CL data for top up of 0x02 validators
 */
abstract contract CLTopUpVerifier {
    // BeaconBlockHeader: state_root field gindex
    uint8 private constant STATE_ROOT_DEPTH = 3;
    uint256 private constant STATE_ROOT_POSITION = 3;
    GIndex public immutable GI_STATE_ROOT = pack((1 << STATE_ROOT_DEPTH) + STATE_ROOT_POSITION, STATE_ROOT_DEPTH);

    // Position (from the end) of parent(slot, proposerIndex) node inside concatenated proof
    uint256 private constant SLOT_PROPOSER_PARENT_PROOF_OFFSET = 2;

    // EIP-4788 system contract
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    // Epoch math, balance threshold
    uint64 internal constant SLOTS_PER_EPOCH = 32;

    // validators[0] / balances[0] gindex before/after fork layout change
    GIndex public immutable GI_FIRST_VALIDATOR_PREV;
    GIndex public immutable GI_FIRST_VALIDATOR_CURR;
    GIndex public immutable GI_FIRST_BALANCE_PREV;
    GIndex public immutable GI_FIRST_BALANCE_CURR;
    GIndex public immutable GI_FIRST_PENDING_CURR;
    GIndex public immutable GI_FIRST_PENDING_PREV;
    uint64 public immutable PIVOT_SLOT;

    error ValidatorIsSlashed();
    error ValidatorIsNotActivated();
    error ValidatorIsExited();
    error InvalidSlot();
    error RootNotFound();
    error NotActiveValidator();
    error InvalidSignLength();

    constructor(
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        GIndex _gIFirstBalancePrev,
        GIndex _gIFirstBalanceCurr,
        GIndex _gIFirstPendingPrev,
        GIndex _gIFirstPendingCurr,
        uint64 _pivotSlot
    ) {
        GI_FIRST_VALIDATOR_PREV = _gIFirstValidatorPrev;
        GI_FIRST_VALIDATOR_CURR = _gIFirstValidatorCurr;
        GI_FIRST_BALANCE_PREV = _gIFirstBalancePrev;
        GI_FIRST_BALANCE_CURR = _gIFirstBalanceCurr;
        GI_FIRST_PENDING_CURR = _gIFirstPendingCurr;
        GI_FIRST_PENDING_PREV = _gIFirstPendingPrev;
        PIVOT_SLOT = _pivotSlot;
    }

    /// @notice Proves validator[i], balances[i], pending_deposits list under the same EIP-4788 anchor, checks WC, checks active status
    function _verifyValidatorWCActiveAndBalance(
        BeaconRootData calldata beaconRootData,
        ValidatorWitness calldata vw,
        BalanceWitness calldata bw,
        PendingWitness[] calldata pw,
        uint256 validatorIndex,
        bytes32 expectedWithdrawalCredentials
    ) internal view virtual {
        // TODO: beaconRootData.slot != 0 ?
        _verifySlot(vw.proofValidator, beaconRootData.slot, beaconRootData.proposerIndex);

        bytes32 parentBlockRoot = _getParentBlockRoot(beaconRootData.childBlockTimestamp);

        _verifyValidatorActive(beaconRootData.slot, vw);

        GIndex gIndexValidator = concat(GI_STATE_ROOT, _getValidatorGI(validatorIndex, beaconRootData.slot));
        // TODO: think is it correct check of wc
        bytes32 validatorLeaf = _validatorHashTreeRoot(vw, expectedWithdrawalCredentials);
        SSZ.verifyProof({proof: vw.proofValidator, root: parentBlockRoot, leaf: validatorLeaf, gI: gIndexValidator});

        // balances[i] branch
        GIndex gIndexBalance = concat(GI_STATE_ROOT, _getBalanceGI(validatorIndex, beaconRootData.slot));
        bytes32 balanceLeaf = SSZ.toLittleEndian(bw.balanceGwei); // uint64 → 32B LE
        SSZ.verifyProof({proof: bw.proofBalance, root: parentBlockRoot, leaf: balanceLeaf, gI: gIndexBalance});

        uint256 pendingCount = pw.length;
        for (uint256 i; i < pendingCount; ++i) {
            PendingWitness calldata w = pw[i];

            // gindex pending_deposits[w.index] с учётом pre/post fork layout
            GIndex gIndexPending = concat(GI_STATE_ROOT, _getPendingDepositGI(w.index, beaconRootData.slot));

            bytes32 pendingLeaf = _pendingDepositHashTreeRoot(w, vw.pubkey, expectedWithdrawalCredentials);

            SSZ.verifyProof({proof: w.proof, root: parentBlockRoot, leaf: pendingLeaf, gI: gIndexPending});
        }
    }

    /// @dev SSZ hash_tree_root(Validator) computed from witness fields.
    function _validatorHashTreeRoot(ValidatorWitness calldata w, bytes32 expectedWithdrawalCredentials)
        internal
        view
        returns (bytes32)
    {
        bytes32[8] memory leaves;
        leaves[0] = BLS12_381.pubkeyRoot(w.pubkey);
        leaves[1] = expectedWithdrawalCredentials;
        leaves[2] = SSZ.toLittleEndian(w.effectiveBalance);
        leaves[3] = SSZ.toLittleEndian(w.slashed ? uint64(1) : 0); // TODO: check
        leaves[4] = SSZ.toLittleEndian(w.activationEligibilityEpoch);
        leaves[5] = SSZ.toLittleEndian(w.activationEpoch);
        leaves[6] = SSZ.toLittleEndian(w.exitEpoch);
        leaves[7] = SSZ.toLittleEndian(w.withdrawableEpoch);

        bytes32[4] memory l1;
        l1[0] = BLS12_381.sha256Pair(leaves[0], leaves[1]);
        l1[1] = BLS12_381.sha256Pair(leaves[2], leaves[3]);
        l1[2] = BLS12_381.sha256Pair(leaves[4], leaves[5]);
        l1[3] = BLS12_381.sha256Pair(leaves[6], leaves[7]);

        bytes32[2] memory l2;
        l2[0] = BLS12_381.sha256Pair(l1[0], l1[1]);
        l2[1] = BLS12_381.sha256Pair(l1[2], l1[3]);

        return BLS12_381.sha256Pair(l2[0], l2[1]);
    }

    function _pendingDepositHashTreeRoot(
        PendingWitness calldata w,
        bytes calldata pubkey,
        bytes32 expectedWithdrawalCredentials
    ) internal view returns (bytes32) {
        bytes32[8] memory leaves;

        leaves[0] = BLS12_381.pubkeyRoot(pubkey);
        leaves[1] = expectedWithdrawalCredentials;

        leaves[2] = SSZ.toLittleEndian(w.amount);

        leaves[3] = _signatureRoot(w.signature);

        // slot и index
        leaves[4] = SSZ.toLittleEndian(w.slot);
        leaves[5] = bytes32(0);

        leaves[6] = bytes32(0);
        leaves[7] = bytes32(0);

        bytes32[4] memory l1;
        l1[0] = BLS12_381.sha256Pair(leaves[0], leaves[1]);
        l1[1] = BLS12_381.sha256Pair(leaves[2], leaves[3]);
        l1[2] = BLS12_381.sha256Pair(leaves[4], leaves[5]);
        l1[3] = BLS12_381.sha256Pair(leaves[6], leaves[7]);

        bytes32[2] memory l2;
        l2[0] = BLS12_381.sha256Pair(l1[0], l1[1]);
        l2[1] = BLS12_381.sha256Pair(l1[2], l1[3]);

        return BLS12_381.sha256Pair(l2[0], l2[1]);
    }

    /// @notice Signature Merkle root calcualtion
    /// @dev Reverts if `signature` length is not 48
    function _signatureRoot(bytes calldata signature) internal view returns (bytes32 root) {
        if (signature.length != 96) revert InvalidSignLength();

        /// @solidity memory-safe-assembly
        assembly {
            // signature is 96 bytes
            // chunk 0: ptr..ptr+31
            // chunk 1: ptr+32..ptr+63
            // chunk 2: ptr+64..ptr+95
            // chunk 3: ptr+96..ptr+127 (zero)
            let ptr := mload(0x40)
            calldatacopy(ptr, signature.offset, 96)
            mstore(add(ptr, 96), 0)

            // make SHA256  for  first 32 bytes
            // building root
            // L0 = sha256(chunk 0 || chunk 1)
            // L1 = sha256(chunk 2 || chunk 3)
            // root = sha256(L0 || L1)
            // read 64 bytes from ptr..ptr+63
            // write 32 bytes to ptr+0x80
            if iszero(staticcall(gas(), 0x02, ptr, 0x40, add(ptr, 0x80), 0x20)) {
                 revert(0, 0)
            }

            // L1 = sha256(chunk 2 || chunk 3)
            // read 64 bytes from ptr+64..ptr+127
            // write 32 bytes to ptr+0xA0
            if iszero(staticcall(gas(), 0x02, add(ptr, 0x40), 0x40, add(ptr, 0xA0), 0x20)) {
                 revert(0, 0)
            }

            // sha256(L0|L1)
            // write 32 bytes to ptr
            mstore(ptr, mload(add(ptr, 0x80)))
            // ptr+0x20..ptr+0x3F - here is 32 bytes
            mstore(add(ptr, 0x20), mload(add(ptr, 0xA0))) 
            // now we have 64 bytes from ptr..ptr+0x3F
            // read 64 bytes from ptr..ptr+0x3F
            // write 32 bytes to ptr
            if iszero(staticcall(gas(), 0x02, ptr, 0x40, ptr, 0x20)) {
                 revert(0, 0)
            }

            root := mload(ptr)
            mstore(0x40, add(ptr, 0xC0))
        }
    }

    /// @dev Checks that (slot, proposerIndex) parent node is present in the same concatenated proof.
    function _verifySlot(bytes32[] calldata proof, uint64 slot, uint64 proposerIndex) internal view {
        bytes32 parentSlotProposer = BLS12_381.sha256Pair(SSZ.toLittleEndian(slot), SSZ.toLittleEndian(proposerIndex));
        if (proof[proof.length - SLOT_PROPOSER_PARENT_PROOF_OFFSET] != parentSlotProposer) {
            revert InvalidSlot();
        }
    }

    function _verifyValidatorActive(uint64 slot, ValidatorWitness calldata w) internal pure {
        // header slot epoch
        uint64 epoch = uint64(slot / SLOTS_PER_EPOCH);
        // Validator should be activated earlier than current epoch
        if (w.activationEpoch >= epoch) revert ValidatorIsNotActivated();
    }

    /// @dev GIndex for Validator[i] given slot (fork-aware).
    function _getValidatorGI(uint256 offset, uint64 provenSlot) internal view returns (GIndex) {
        GIndex gI = provenSlot < PIVOT_SLOT ? GI_FIRST_VALIDATOR_PREV : GI_FIRST_VALIDATOR_CURR;
        return gI.shr(offset);
    }

    /// @dev GIndex for balances[i] given slot (fork-aware).
    function _getBalanceGI(uint256 offset, uint64 provenSlot) internal view returns (GIndex) {
        GIndex gI = provenSlot < PIVOT_SLOT ? GI_FIRST_BALANCE_PREV : GI_FIRST_BALANCE_CURR;
        return gI.shr(offset);
    }

    function _getPendingDepositGI(uint256 offset, uint64 provenSlot) internal view returns (GIndex) {
        GIndex gI = provenSlot < PIVOT_SLOT ? GI_FIRST_PENDING_PREV : GI_FIRST_PENDING_CURR;
        return gI.shr(offset);
    }

    /// @dev Reads parent_beacon_block_root from EIP-4788 by timestamp.
    function _getParentBlockRoot(uint64 childBlockTimestamp) internal view returns (bytes32) {
        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(childBlockTimestamp));
        if (!success || data.length == 0) revert RootNotFound();
        return abi.decode(data, (bytes32));
    }
}
