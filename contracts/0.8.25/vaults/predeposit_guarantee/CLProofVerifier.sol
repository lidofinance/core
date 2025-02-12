// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex, pack, concat} from "contracts/0.8.25/lib/GIndex.sol";
import {SSZ} from "contracts/0.8.25/lib/SSZ.sol";

import {ICLProofVerifier} from "../interfaces/IPredepositGuarantee.sol";

/**
 * @title CLProofVerifier
 * @author Lido
 * @notice
 *
 * CLProofVerifier is base abstract contract that provides internal method to verify
 * merkle proofs of validator entry in CL. It uses concatenated proofs that prove
 * validator existence in CL just from pubkey and withdrawalCredentials againts Beacon block root
 * stored in BeaconRoots contract.
 *
 *
 * NB!: GI_FIRST_VALIDATOR must be updated if Ethereum hardfork changes order of CL state tree
 * (e.g. Pectra, Altair, etc.)
 *
 */
abstract contract CLProofVerifier is ICLProofVerifier {
    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    // GIndex of parent node for (Pubkey,WC) in validator container
    // unlikely to change, same between mainnet/testnets
    GIndex public immutable GI_PUBKEY_WC_PARENT = pack(1 << 2, 2);
    // GIndex of stateRoot in Beacon Block state
    // unlikely to change, same between mainnet/testnets
    GIndex public immutable GI_STATE_VIEW = pack((1 << 3) + 3, 3);
    // Index of first validator in CL state
    // can change between hardforks and must be updated
    GIndex public immutable GI_FIRST_VALIDATOR;

    constructor(GIndex _gIFirstValidator) {
        GI_FIRST_VALIDATOR = _gIFirstValidator;
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
        GIndex _gIndex = concat(GI_STATE_VIEW, concat(_getValidatorGI(_witness.validatorIndex), GI_PUBKEY_WC_PARENT));

        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.childBlockTimestamp),
            leaf: _leaf,
            gIndex: _gIndex
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
        return GI_FIRST_VALIDATOR.shr(_offset);
    }

    error RootNotFound();
}
