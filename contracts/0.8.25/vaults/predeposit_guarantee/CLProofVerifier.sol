// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex, pack, concat} from "contracts/0.8.25/lib/GIndex.sol";
import {SSZ, BeaconBlockHeader} from "contracts/0.8.25/lib/SSZ.sol";

/**
 * @title CLProofVerifier
 * @author Lido
 * @notice
 *
 * CLProofVerifier is base abstract contract that provides internal method to verify
 * merkle proofs of validator entry in CL. It uses concatenated proofs that prove
 * validator existence in CL just from pubkey and withdrawalCredentials againts Beacon block root
 * stored in BeaconRoots system contract.
 *
 *
 * NB!: GI_FIRST_VALIDATOR must be updated if Ethereum hardfork changes order of CL state tree
 * (e.g. Pectra, Fusaka, etc.)
 *
 */
abstract contract CLProofVerifier {
    struct ValidatorWitness {
        bytes32[] proof;
        bytes pubkey;
        uint256 validatorIndex;
        uint64 childBlockTimestamp;
    }

    struct CLProofVerifierERC7201Storage {
        uint64 latestProvenSlot;
        uint64 latestProvenSlotTimestamp;
    }

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         keccak256(abi.encode(uint256(keccak256("Lido.Vaults.CLProofVerifier")) - 1)) & ~bytes32(uint256(0xff));
     */
    bytes32 private constant CL_PROOF_VERIFIER_STORAGE_LOCATION =
        0x345c2759b654c4a1f4e918fb90cc43c20694c04e946964cebe7cf9d73c2c0200;

    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    /**  GIndex of parent node for (Pubkey,WC) in validator container
     *   unlikely to change, same between mainnet/testnets.
     *   Scheme of Validator Container Tree:
     *
                            Validator Container Root
                                        │
                        ┌───────────────┴───────────────┐
                        │                               │
                    node                            proof[1]            **DEPTH = 1
                        │                               │
                ┌───────┴───────┐               ┌───────┴───────┐
                │               │               │               │
        Proven Parent      proof[0]        node             node        **DEPTH = 2
                │               │               │               │
        ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
        │           │   │           │   │           │   │           │
    [pubkeyRoot]  [wc]  [EB] [slashed] [AEE]      [AE] [EE]       [WE] **DEPTH = 3
    {.................}
            ↑
    what needs to be proven

     *   VALIDATOR_TREE_DEPTH = 2
     *   POSITION = 0 as parent node is first in the row at DEPTH 2
     *   GI_PUBKEY_WC_PARENT = pack((1 << VALIDATOR_TREE_DEPTH) + POSITION, VALIDATOR_TREE_DEPTH);
     *
     */
    GIndex public immutable GI_PUBKEY_WC_PARENT = pack(1 << 2, 2);
    //
    //
    /**  GIndex of stateRoot in Beacon Block state
     *   unlikely to change, same between mainnet/testnets
     *   Scheme of Beacon Block Tree:
     *
                                Beacon Block Root
                                        │
                        ┌───────────────┴──────────────────────────┐
                        │                                          │
                        node                                       proof[2]        **DEPTH = 1
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
     *   BEACON_HEADER_TREE_DEPTH = 3
     *   POSITION = 3 as stateRoot position in a leaf row of the tree
     *   GI_STATE_VIEW = pack((1 << BEACON_HEADER_TREE_DEPTH) + POSITION, BEACON_HEADER_TREE_DEPTH);
     */
    GIndex public immutable GI_STATE_VIEW = pack((1 << 3) + 3, 3);
    // Index of first validator in CL state
    // can change between hardforks and must be updated
    GIndex public immutable GI_FIRST_VALIDATOR;
    GIndex public immutable GI_FIRST_VALIDATOR_AFTER_CHANGE;
    uint64 public immutable SLOT_CHANGE_GI;

    constructor(GIndex _gIFirstValidator, GIndex _gIFirstValidatorAfterChange, uint64 _changeSlot) {
        GI_FIRST_VALIDATOR = _gIFirstValidator;
        GI_FIRST_VALIDATOR_AFTER_CHANGE = _gIFirstValidatorAfterChange;
        SLOT_CHANGE_GI = _changeSlot;
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
        // parent node for first two leaves in validator container tree
        // pubkey + wc
        bytes32 _leaf = SSZ.sha256Pair(SSZ.pubkeyRoot(_witness.pubkey), _withdrawalCredentials);
        // concatenated index for parent(pubkey + wc) ->  Validator Index in state tree -> stateView Index in Beacon block Tree
        GIndex _gIndex = concat(
            GI_STATE_VIEW,
            concat(_getValidatorGI(_witness.validatorIndex, _witness.childBlockTimestamp), GI_PUBKEY_WC_PARENT)
        );

        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.childBlockTimestamp),
            leaf: _leaf,
            gIndex: _gIndex
        });
    }

    /**
     * @notice updates current slot of CL to enact first Validator GI transition
     * @param _beaconBlockHeader object containing Beacon block header container from CL
     * @param _childBlockTimestamp to access Beacon block root
     * @dev reverts with `InvalidProof` when _beaconBlockHeader cannot be proven to Beacon block root
     */
    function proveSlotChange(BeaconBlockHeader calldata _beaconBlockHeader, uint64 _childBlockTimestamp) public {
        CLProofVerifierERC7201Storage storage $ = _getCLProofVerifierStorage();
        SSZ.verifyBeaconBlockHeader(_beaconBlockHeader, _getParentBlockRoot(_childBlockTimestamp));

        uint64 provenSlot = _beaconBlockHeader.slot;

        if ($.latestProvenSlot > provenSlot) {
            revert SlotAlreadyProven();
        }

        if (provenSlot < SLOT_CHANGE_GI || $.latestProvenSlot >= SLOT_CHANGE_GI) {
            revert SlotUpdateHasNoEffect();
        }

        $.latestProvenSlot = _beaconBlockHeader.slot;
        $.latestProvenSlotTimestamp = _childBlockTimestamp;

        emit SlotProven(_beaconBlockHeader.slot, _childBlockTimestamp);
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
    function _getValidatorGI(uint256 _offset, uint64 childBlockTimestamp) internal view returns (GIndex) {
        CLProofVerifierERC7201Storage storage $ = _getCLProofVerifierStorage();
        // will only activate change if proving for block that has timestamp after SLOT_CHANGE_GI
        // can survive upgrade of implementation where GI_FIRST_VALIDATOR_AFTER_CHANGE->GI_FIRST_VALIDATOR
        if (childBlockTimestamp >= $.latestProvenSlotTimestamp && $.latestProvenSlot >= SLOT_CHANGE_GI) {
            return GI_FIRST_VALIDATOR_AFTER_CHANGE.shr(_offset);
        } else {
            return GI_FIRST_VALIDATOR.shr(_offset);
        }
    }

    function _getCLProofVerifierStorage() private pure returns (CLProofVerifierERC7201Storage storage $) {
        assembly {
            $.slot := CL_PROOF_VERIFIER_STORAGE_LOCATION
        }
    }

    event SlotProven(uint64 provenSlot, uint64 provenSlotTimestamp);

    error InvalidTimestamp();
    error SlotUpdateHasNoEffect();
    error SlotAlreadyProven();
    error RootNotFound();
}
