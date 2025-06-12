// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {pack, concat} from "contracts/common/lib/GIndex.sol";
import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";
import {CLProofVerifier, SSZ, GIndex} from "contracts/0.8.25/vaults/predeposit_guarantee/CLProofVerifier.sol";

contract CLProofVerifier__Harness is CLProofVerifier {
    constructor(
        GIndex _gIFirstValidator,
        GIndex _gIFirstValidatorAfterChange,
        uint64 _changeSlot
    ) CLProofVerifier(_gIFirstValidator, _gIFirstValidatorAfterChange, _changeSlot) {}

    function TEST_validatePubKeyWCProof(
        IPredepositGuarantee.ValidatorWitness calldata _witness,
        bytes32 _withdrawalCredentials
    ) public view {
        _validatePubKeyWCProof(_witness, _withdrawalCredentials);
    }

    function TEST_getParentBlockRoot(uint64 parentBlockTimestamp) public view returns (bytes32) {
        return _getParentBlockRoot(parentBlockTimestamp);
    }

    function TEST_getValidatorGI(uint256 offset, uint64 slot) public view returns (GIndex) {
        return _getValidatorGI(offset, slot);
    }
}
