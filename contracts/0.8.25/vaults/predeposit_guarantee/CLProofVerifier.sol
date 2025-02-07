// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex, pack, concat} from "contracts/0.8.25/lib/GIndex.sol";
import {SSZ} from "contracts/0.8.25/lib/SSZ.sol";

abstract contract CLProofVerifier {
    struct ValidatorWitness {
        bytes32[] proof;
        bytes pubkey;
        uint256 validatorIndex;
        uint64 parentBlockTimestamp;
    }

    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public immutable BEACON_ROOTS;

    // Index of parent node for (Pubkey,WC) in validator container
    GIndex public immutable GI_PUBKEY_WC_PARENT = pack(1 << 2, 2);
    // Index of first validator in CL state
    GIndex public immutable GI_FIRST_VALIDATOR;
    // Index of stateView in beacon state
    GIndex public immutable GI_STATE_VIEW = pack((1 << 3) + 3, 3);

    constructor(GIndex _gIFirstValidator) {
        BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;
        GI_FIRST_VALIDATOR = _gIFirstValidator;
    }

    function _validatePubKeyWCProof(ValidatorWitness calldata _witness, bytes32 _withdrawalCredentials) internal view {
        // parent node for first two leaves in validator container tree
        // pubkey + wc
        bytes32 _leaf = SSZ.sha256Pair(SSZ.pubkeyRoot(_witness.pubkey), _withdrawalCredentials);
        // concatenated index for parent(pubkey + wc) ->  Validator Index in state tree -> stateView Index in Beacon Block Tree
        GIndex _gIndex = concat(GI_STATE_VIEW, concat(_getValidatorGI(_witness.validatorIndex), GI_PUBKEY_WC_PARENT));

        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.parentBlockTimestamp),
            leaf: _leaf,
            gIndex: _gIndex
        });
    }

    function _getParentBlockRoot(uint64 blockTimestamp) internal view returns (bytes32) {
        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(blockTimestamp));

        if (!success || data.length == 0) {
            revert RootNotFound();
        }

        return abi.decode(data, (bytes32));
    }

    function _getValidatorGI(uint256 offset) internal view returns (GIndex) {
        return GI_FIRST_VALIDATOR.shr(offset);
    }

    error InvalidGeneralIndex(uint256);
    error RootNotFound();
}
