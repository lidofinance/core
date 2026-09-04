// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {GIndex} from "contracts/common/lib/GIndex.sol";
import {PredepositGuarantee} from "contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee.sol";

contract PredepositGuarantee__HarnessForFactory is PredepositGuarantee {
    constructor(
        bytes4 _genesisForkVersion,
        GIndex _gIFirstValidatorPreGloas,
        GIndex _gIValidators,
        uint64 _pivotSlot
    ) PredepositGuarantee(_genesisForkVersion, _gIFirstValidatorPreGloas, _gIValidators, _pivotSlot) {}
}
