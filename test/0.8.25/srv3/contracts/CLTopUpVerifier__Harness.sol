// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {GIndex} from "contracts/common/lib/GIndex.sol";
import {CLTopUpVerifier} from "contracts/0.8.25/CLTopUpVerifier.sol";
import {BeaconRootData, ValidatorWitness} from "contracts/common/interfaces/TopUpWitness.sol";

contract CLTopUpVerifier__Harness is CLTopUpVerifier {
    constructor(
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        uint64 _pivotSlot
    ) CLTopUpVerifier(_gIFirstValidatorPrev, _gIFirstValidatorCurr, _pivotSlot) {}

    function TEST_verifyValidator(
        BeaconRootData calldata beaconData,
        ValidatorWitness calldata vw,
        uint256 validatorIndex,
        bytes32 withdrawalCredentials
    ) public view {
        _verifyValidator(beaconData, vw, validatorIndex, withdrawalCredentials);
    }

    function TEST_getParentBlockRoot(uint64 parentBlockTimestamp) public view returns (bytes32) {
        return _getParentBlockRoot(parentBlockTimestamp);
    }

    function TEST_getValidatorGI(uint256 offset, uint64 slot) public view returns (GIndex) {
        return _getValidatorGI(offset, slot);
    }
}
