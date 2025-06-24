// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex, pack, concat} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {BLS12_381} from "contracts/common/lib/BLS.sol";

import {IPredepositGuarantee} from "../interfaces/IPredepositGuarantee.sol";

/**
 * @title CLProofVerifier
 * @author Lido
 * @notice
 *
 * CLProofVerifier is base abstract contract that provides internal method to verify
 * merkle proofs of validator entry in CL. It uses concatenated proofs that prove
 * validator existence in CL just from pubkey and withdrawalCredentials against Beacon block root
 * stored in BeaconRoots system contract (see EIP-4788).
 *
 */
abstract contract CLProofVerifier {
    /**
     * @notice CLProofVerifier accepts concatenated Merkle proofs to verify existence of correct pubkey+WC validator on CL
     * Proof consists of:
     *  I:   Merkle proof of validator container - from parent(pubkey,wc) node to Validator Container Root
     *  II:  Merkle proof of CL state - from Validator Container Root to State Root
     *  III: Merkle proof of Beacon block header - from State Root to Beacon block root
     *
     * In order to build proof you must collect all proofs from I, II, III and concatenate them into single array
     * We also concatenate GIndexes under the hood to properly traverse the superset tree up to the final root
     * Below is breakdown of each layer:
     */

    /*  GIndex of parent node for (Pubkey,WC) in validator container
     *   unlikely to change, same between mainnet/testnets.
     *   Scheme of Validator Container Tree:
     *
                            Validator Container Root                      **DEPTH = 0
                                        │
                        ┌───────────────┴───────────────┐
                        │                               │
                    node                            proof[1]              **DEPTH = 1
                        │                               │
                ┌───────┴───────┐               ┌───────┴───────┐
                │               │               │               │
         PARENT TO PROVE      proof[0]        node             node       **DEPTH = 2
                │               │               │               │
          ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
          │           │   │           │   │           │   │           │
       [pubkeyRoot]  [wc]  [EB] [slashed] [AEE]      [AE] [EE]       [WE] **DEPTH = 3
       {.................}
                ↑
       data to be proven
    */
    uint8 private constant WC_PUBKEY_PARENT_DEPTH = 2;
    uint256 private constant WC_PUBKEY_PARENT_POSITION = 0;

    /// @notice GIndex of parent node for (Pubkey,WC) in validator container
    GIndex public immutable GI_PUBKEY_WC_PARENT =
        pack((1 << WC_PUBKEY_PARENT_DEPTH) + WC_PUBKEY_PARENT_POSITION, WC_PUBKEY_PARENT_DEPTH);

    /**  GIndex of validator in state tree is calculated dynamically
     *   offsetting from GIndex of first validator by proving validator numerical index
     *
     * NB! Position of validators in CL state tree can change between ethereum hardforks
     *     so two values must be stored and used depending on the slot of beacon block in proof.
     *
     *   Scheme of CL State Tree:
     *
                                CL State Tree                           **DEPTH = 0
                                        │
                        ┌───────────────┴───────────────┐
                        │                               │
             .......................................................
                │                               │
          ┌─────┴─────┐                   ┌─────┴─────┐
          │           │   ............... │           │
    [Validator 0]                        ....     [Validator to prove]  **DEPTH = N
            ↑                                               ↑
    GI_FIRST_VALIDATOR                   GI_FIRST_VALIDATOR + validator_index
    */

    /// @notice GIndex of first validator in CL state tree
    /// @dev This index is relative to a state like: `BeaconState.validators[0]`.
    GIndex public immutable GI_FIRST_VALIDATOR_PREV;
    /// @notice GIndex of first validator in CL state tree after PIVOT_SLOT
    GIndex public immutable GI_FIRST_VALIDATOR_CURR;
    /// @notice slot when GIndex change will occur due to the hardfork
    uint64 public immutable PIVOT_SLOT;

    /**
     *   GIndex of stateRoot in Beacon Block state is
     *   unlikely to change and same between mainnet/testnets
     *   Scheme of Beacon Block Tree:
     *
                                Beacon Block Root(from EIP-4788 Beacon Roots Contract)
                                        │
                        ┌───────────────┴──────────────────────────┐
                        │                                          │
                        node                                      proof[2]        **DEPTH = 1
                        │                                          │
                ┌───────┴───────┐                          ┌───────┴───────┐
                │               │                          │               │
  used to -> proof[1]          node                      node             node     **DEPTH = 2
  verify slot   │               │                          │               │
      ┌─────────┴─────┐   ┌─────┴───────────┐        ┌─────┴─────┐     ┌───┴──┐
      │               │   │                 │        │           │     │      │
    [slot]  [proposerInd] [parentRoot] [stateRoot]  [bodyRoot]  [0]   [0]    [0]   **DEPTH = 3
       ↑                   (proof[0])       ↑
    needed for GIndex                  what needs to be proven
     */
    uint8 private constant STATE_ROOT_DEPTH = 3;
    uint256 private constant STATE_ROOT_POSITION = 3;
    /// @notice GIndex of state root in Beacon block header
    GIndex public immutable GI_STATE_ROOT = pack((1 << STATE_ROOT_DEPTH) + STATE_ROOT_POSITION, STATE_ROOT_DEPTH);

    /// @notice location(from end) of parent node for (slot,proposerInd) in concatenated merkle proof
    uint256 private constant SLOT_PROPOSER_PARENT_PROOF_OFFSET = 2;

    /// @notice see `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    /**
     * @param _gIFirstValidatorPrev packed(general index | depth in Merkle tree, see GIndex.sol) GIndex of first validator in CL state tree
     * @param _gIFirstValidatorCurr packed GIndex of first validator after fork changes tree structure
     * @param _pivotSlot slot of the fork that alters first validator GIndex
     * @dev if no fork changes are known,  _gIFirstValidatorPrev = _gIFirstValidatorCurr and _changeSlot = 0
     */
    constructor(GIndex _gIFirstValidatorPrev, GIndex _gIFirstValidatorCurr, uint64 _pivotSlot) {
        GI_FIRST_VALIDATOR_PREV = _gIFirstValidatorPrev;
        GI_FIRST_VALIDATOR_CURR = _gIFirstValidatorCurr;
        PIVOT_SLOT = _pivotSlot;
    }

    /**
     * @notice validates proof of validator in CL with withdrawalCredentials and pubkey against Beacon block root
     * @param _witness object containing user input passed as calldata
     *  `proof` - array of hashes for concatenated merkle proof from parent(pubkey,wc) node to the Beacon block root
     *  `pubkey` - pubkey of the validator
     *  `validatorIndex` - numerical index of validator in CL
     *  `childBlockTimestamp` - timestamp of EL block that has Beacon root corresponding to proof
     *  `slot` - slot of the Beacon block that has the state root
     *  `proposerIndex` - proposer index of the Beacon block that has the state root
     * @param _withdrawalCredentials to verify proof with
     * @dev reverts with `InvalidProof` when provided input cannot be proven to Beacon block root
     */
    function _validatePubKeyWCProof(
        IPredepositGuarantee.ValidatorWitness calldata _witness,
        bytes32 _withdrawalCredentials
    ) internal view {
        // verifies user provided slot against user provided proof
        // proof verification is done in `SSZ.verifyProof` and is not affected by slot
        _verifySlot(_witness);

        // parent node for first two leaves in validator container tree: pubkey & wc
        // we use 'leaf' instead of 'node' due to proving a subtree where this node is a leaf
        bytes32 leaf = BLS12_381.sha256Pair(BLS12_381.pubkeyRoot(_witness.pubkey), _withdrawalCredentials);

        // concatenated GIndex for
        // parent(pubkey + wc) ->  Validator Index in state tree -> stateView Index in Beacon block Tree
        GIndex gIndex = concat(
            GI_STATE_ROOT,
            concat(_getValidatorGI(_witness.validatorIndex, _witness.slot), GI_PUBKEY_WC_PARENT)
        );

        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.childBlockTimestamp),
            leaf: leaf,
            gI: gIndex
        });
    }

    /**
     * @notice returns parent CL block root for given child block timestamp
     * @param _witness object containing proof, slot and proposerIndex
     * @dev checks slot and proposerIndex against proof[:-2] which latter is verified against Beacon block root
     * This is a trivial case of multi Merkle proofs where a short proof branch proves slot
     */
    function _verifySlot(IPredepositGuarantee.ValidatorWitness calldata _witness) internal view {
        bytes32 parentSlotProposer = BLS12_381.sha256Pair(
            SSZ.toLittleEndian(_witness.slot),
            SSZ.toLittleEndian(_witness.proposerIndex)
        );
        if (_witness.proof[_witness.proof.length - SLOT_PROPOSER_PARENT_PROOF_OFFSET] != parentSlotProposer) {
            revert InvalidSlot();
        }
    }

    /**
     * @notice calculates general validator index in CL state tree by provided offset
     * @param _offset from first validator (Validator Index)
     * @param _provenSlot slot of the Beacon block for which proof is collected
     * @return gIndex of container in CL state tree
     */
    function _getValidatorGI(uint256 _offset, uint64 _provenSlot) internal view returns (GIndex) {
        GIndex gI = _provenSlot < PIVOT_SLOT ? GI_FIRST_VALIDATOR_PREV : GI_FIRST_VALIDATOR_CURR;
        return gI.shr(_offset);
    }

    /**
     * @notice returns parent CL block root for given child block timestamp
     * @param _childBlockTimestamp timestamp of child block
     * @return parent block root
     * @dev reverts with `RootNotFound` if timestamp is not found in Beacon Block roots
     */
    function _getParentBlockRoot(uint64 _childBlockTimestamp) internal view returns (bytes32) {
        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(_childBlockTimestamp));

        if (!success || data.length == 0) {
            revert RootNotFound();
        }

        return abi.decode(data, (bytes32));
    }

    error InvalidTimestamp();
    error InvalidSlot();
    error RootNotFound();
}
