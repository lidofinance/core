// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {GIndex, pack, concat} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {BLS12_381} from "contracts/common/lib/BLS.sol";
import {BeaconRootData, ValidatorWitness} from "../common/interfaces/TopUpWitness.sol";

/**
 * @title CLTopUpVerifier
 * @author Lido
 * @notice
 *
 * Smart contract verifying CL data of validators
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

    // validators[0] gindex before/after fork layout change
    GIndex public immutable GI_FIRST_VALIDATOR_PREV;
    GIndex public immutable GI_FIRST_VALIDATOR_CURR;
    uint64 public immutable PIVOT_SLOT;

    error InvalidSlot();
    error RootNotFound();
    error InvalidSignLength();

    constructor(GIndex _gIFirstValidatorPrev, GIndex _gIFirstValidatorCurr, uint64 _pivotSlot) {
        GI_FIRST_VALIDATOR_PREV = _gIFirstValidatorPrev;
        GI_FIRST_VALIDATOR_CURR = _gIFirstValidatorCurr;
        PIVOT_SLOT = _pivotSlot;
    }

    /// @notice Proves validator[i] under the same EIP-4788 anchor, checks WC, checks active status
    function _verifyValidator(
        BeaconRootData calldata _beaconRootData,
        ValidatorWitness calldata _vw,
        uint256 _validatorIndex,
        bytes32 _expectedWithdrawalCredentials
    ) internal view virtual {
        _verifySlot(_vw.proofValidator, _beaconRootData.slot, _beaconRootData.proposerIndex);

        bytes32 parentBlockRoot = _getParentBlockRoot(_beaconRootData.childBlockTimestamp);

        GIndex gIndexValidator = concat(GI_STATE_ROOT, _getValidatorGI(_validatorIndex, _beaconRootData.slot));
        bytes32 validatorLeaf = _validatorHashTreeRoot(_vw, _expectedWithdrawalCredentials);
        SSZ.verifyProof({proof: _vw.proofValidator, root: parentBlockRoot, leaf: validatorLeaf, gI: gIndexValidator});
    }

    /// @dev SSZ hash_tree_root(Validator) computed from witness fields.
    function _validatorHashTreeRoot(ValidatorWitness calldata _w, bytes32 _expectedWithdrawalCredentials)
        internal
        view
        returns (bytes32)
    {
        bytes32[8] memory leaves;
        leaves[0] = BLS12_381.pubkeyRoot(_w.pubkey);
        leaves[1] = _expectedWithdrawalCredentials;
        leaves[2] = SSZ.toLittleEndian(_w.effectiveBalance);
        leaves[3] = SSZ.toLittleEndian(_w.slashed ? uint64(1) : 0);
        leaves[4] = SSZ.toLittleEndian(_w.activationEligibilityEpoch);
        leaves[5] = SSZ.toLittleEndian(_w.activationEpoch);
        leaves[6] = SSZ.toLittleEndian(_w.exitEpoch);
        leaves[7] = SSZ.toLittleEndian(_w.withdrawableEpoch);

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

    /// @dev Checks that (slot, proposerIndex) parent node is present in the same concatenated proof.
    function _verifySlot(bytes32[] calldata _proof, uint64 _slot, uint64 _proposerIndex) internal view {
        bytes32 parentSlotProposer = BLS12_381.sha256Pair(SSZ.toLittleEndian(_slot), SSZ.toLittleEndian(_proposerIndex));
        if (_proof[_proof.length - SLOT_PROPOSER_PARENT_PROOF_OFFSET] != parentSlotProposer) {
            revert InvalidSlot();
        }
    }

    /// @dev GIndex for Validator[i] given slot (fork-aware).
    function _getValidatorGI(uint256 _offset, uint64 _provenSlot) internal view returns (GIndex) {
        GIndex gI = _provenSlot < PIVOT_SLOT ? GI_FIRST_VALIDATOR_PREV : GI_FIRST_VALIDATOR_CURR;
        return gI.shr(_offset);
    }

    /// @dev Reads parent_beacon_block_root from EIP-4788 by timestamp.
    function _getParentBlockRoot(uint64 _childBlockTimestamp) internal view returns (bytes32) {
        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(_childBlockTimestamp));
        if (!success || data.length == 0) revert RootNotFound();
        return abi.decode(data, (bytes32));
    }
}
