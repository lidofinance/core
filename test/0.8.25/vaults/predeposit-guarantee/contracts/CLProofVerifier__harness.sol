// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import "hardhat/console.sol";

import {pack} from "contracts/0.8.25/lib/GIndex.sol";

import {CLProofVerifier, Validator, SSZ, ValidatorWitness, GIndex} from "contracts/0.8.25/vaults/predeposit_guarantee/CLProofVerifier.sol";

contract CLProofVerifier__Harness is CLProofVerifier {
    bytes32 public MOCK_ROOT;

    constructor() CLProofVerifier(pack(0x560000000000, 40)) {}

    function setRoot(bytes32 _root) public {
        MOCK_ROOT = _root;
    }

    function _getParentBlockRoot(uint64) internal view override returns (bytes32) {
        return MOCK_ROOT;
    }

    function TEST_validateWCProof(ValidatorWitness calldata _witness) public view {
        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.beaconBlockTimestamp),
            leaf: SSZ.hashTreeRoot(_witness.validator),
            gIndex: _getValidatorGI(_witness.validatorIndex)
        });
    }
}
