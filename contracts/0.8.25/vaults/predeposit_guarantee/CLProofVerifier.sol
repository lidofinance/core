// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Validator, SSZ, GIndex} from "contracts/0.8.25/lib/SSZ.sol";

struct ValidatorWitness {
    Validator validator;
    bytes32[] proof;
    uint256 validatorIndex;
    uint64 beaconBlockTimestamp;
}

abstract contract CLProofVerifier {
    using SSZ for Validator;
    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public immutable BEACON_ROOTS;
    GIndex public immutable GI_FIRST_VALIDATOR;

    constructor(GIndex _gIFirstValidator) {
        BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;
        GI_FIRST_VALIDATOR = _gIFirstValidator;
    }

    function _validateWCProof(ValidatorWitness calldata _witness) internal view {
        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.beaconBlockTimestamp),
            leaf: _witness.validator.hashTreeRoot(),
            gIndex: _getValidatorGI(_witness.validatorIndex)
        });
    }

    // virtual for testing
    function _getParentBlockRoot(uint64 blockTimestamp) internal view virtual returns (bytes32) {
        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(blockTimestamp));

        if (!success || data.length == 0) {
            revert RootNotFound();
        }

        return abi.decode(data, (bytes32));
    }

    function _getValidatorGI(uint256 offset) internal view returns (GIndex) {
        return GI_FIRST_VALIDATOR.shr(offset);
    }

    // proving errors
    error InvalidGeneralIndex(uint256);
    error RootNotFound();
}
