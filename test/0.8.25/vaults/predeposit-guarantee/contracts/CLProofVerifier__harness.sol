// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {pack, concat} from "contracts/0.8.25/lib/GIndex.sol";
import {CLProofVerifier, SSZ, GIndex} from "contracts/0.8.25/vaults/predeposit_guarantee/CLProofVerifier.sol";

contract CLProofVerifier__Harness is CLProofVerifier {
    constructor(GIndex _gIFirstValidator) CLProofVerifier(_gIFirstValidator) {}

    function TEST_validatePubKeyWCProof(
        ValidatorWitness calldata _witness,
        bytes32 _withdrawalCredentials
    ) public view {
        _validatePubKeyWCProof(_witness, _withdrawalCredentials);
    }

    function TEST_getParentBlockRoot(uint64 parentBlockTimestamp) public view returns (bytes32) {
        return _getParentBlockRoot(parentBlockTimestamp);
    }

    function TEST_getValidatorGI(uint256 offset) public view returns (GIndex) {
        return GI_FIRST_VALIDATOR.shr(offset);
    }
}
