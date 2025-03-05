// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex, pack, concat} from "contracts/0.8.25/lib/GIndex.sol";
import {SSZ} from "contracts/0.8.25/lib/SSZ.sol";

/**
 * @title CLProofVerifier
 * @author Lido
 * @notice
 *
 * CLProofVerifier is base abstract contract that provides internal method to verify
 * merkle proofs of validator entry in CL. It uses concatenated proofs that prove
 * validator existence in CL just from pubkey and withdrawalCredentials againts Beacon block root
 * stored in BeaconRoots system contract (see EIP-4788).
 *
 */
abstract contract CLProofVerifier {
    /**
     * @notice user input for validator proof verification
     * @custom:proof array of merkle proofs from parent(pubkey,wc) node to Beacon block root
     * @custom:pubkey of validator to prove
     * @custom:validatorIndex of validator in CL state tree
     * @custom:childBlockTimestamp of EL block that has parent block beacon root in BEACON_ROOTS contract
     */
    struct ValidatorWitness {
        bytes32[] proof;
        bytes pubkey;
        uint256 validatorIndex;
        uint64 childBlockTimestamp;
    }

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
    uint8 public constant WC_PUBKEY_PARENT_DEPTH = 2;
    uint256 public constant WC_PUBKEY_PARENT_POSITION = 0;

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
    [Validator 0]                        ....     [Proven Validator]    **DEPTH = N
            ↑                                               ↑
    GI_FIRST_VALIDATOR                   GI_FIRST_VALIDATOR + validator_index
    */

    /// @notice GIndex of first validator in CL state tree
    GIndex public immutable GI_FIRST_VALIDATOR;
    /// @notice GIndex of first validator in CL state tree after change
    GIndex public immutable GI_FIRST_VALIDATOR_AFTER_CHANGE;
    /// @notice slot when change will occur
    uint64 public immutable SLOT_CHANGE_GI_FIRST_VALIDATOR;

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
            proof[1]           node                      node             node     **DEPTH = 2
                │               │                          │               │
      ┌─────────┴─────┐   ┌─────┴───────────┐        ┌─────┴─────┐     ┌───┴──┐
      │               │   │                 │        │           │     │      │
    [slot]  [proposerInd] [parentRoot] [stateRoot]  [bodyRoot]  [0]   [0]    [0]   **DEPTH = 3
                               (proof[0])       ↑
                                        what needs to be proven
     */
    uint8 public constant STATE_ROOT_DEPTH = 3;
    uint256 public constant STATE_ROOT_POSITION = 3;
    /// @notice GIndex of state root in Beacon block header
    GIndex public immutable GI_STATE_ROOT = pack((1 << STATE_ROOT_DEPTH) + STATE_ROOT_POSITION, STATE_ROOT_DEPTH);

    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    constructor(GIndex _gIFirstValidator, GIndex _gIFirstValidatorAfterChange, uint64 _changeSlot) {
        GI_FIRST_VALIDATOR = _gIFirstValidator;
        GI_FIRST_VALIDATOR_AFTER_CHANGE = _gIFirstValidatorAfterChange;
        SLOT_CHANGE_GI_FIRST_VALIDATOR = _changeSlot;
    }

    /**
     * @notice validates proof of validator in CL with withdrawalCredentials and pubkey against Beacon block root
     * @param _witness object containing user input passed as calldata
     *  `proof` - array of hashes for concatenated merkle proof from parent(pubkey,wc) node to the Beacon block root
     *  `pubkey` - pubkey of the validator
     *  `validatorIndex` - numerical index of validator in CL
     *  `childBlockTimestamp` - timestamp of EL block that has Beacon root corresponding to proof
     * @param _withdrawalCredentials to verify proof with
     * @dev reverts with `InvalidProof` when provided input cannot be proven to Beacon block root
     */
    function _validatePubKeyWCProof(ValidatorWitness calldata _witness, bytes32 _withdrawalCredentials) internal view {
        // parent node for first two leaves in validator container tree: pubkey & wc
        // we use 'leaf' instead of 'node' due to proving a subtree where this node is a leaf
        bytes32 leaf = SSZ.sha256Pair(SSZ.pubkeyRoot(_witness.pubkey), _withdrawalCredentials);
        // concatenated index for parent(pubkey + wc) ->  Validator Index in state tree -> stateView Index in Beacon block Tree
        GIndex gIndex = concat(GI_STATE_ROOT, concat(_getValidatorGI(_witness.validatorIndex), GI_PUBKEY_WC_PARENT));

        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.childBlockTimestamp),
            leaf: leaf,
            gIndex: gIndex
        });
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

    /**
     * @notice calculates general validator index in CL state tree by provided offset
     * @param _offset from first validator (Validator Index)
     * @return gIndex of container in CL state tree
     */
    function _getValidatorGI(uint256 _offset) internal view returns (GIndex) {
        // TODO get correct GI based on hardfork
        // possible solutions:
        // 1. allow permissionless proof of new GIndex
        // 2. allow users to bring BeaconBlockHeader or Slot and verify it

        return GI_FIRST_VALIDATOR.shr(_offset);
    }

    error InvalidTimestamp();
    error RootNotFound();
}
