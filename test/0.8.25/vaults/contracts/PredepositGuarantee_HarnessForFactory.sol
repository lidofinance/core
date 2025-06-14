// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {GIndex} from "contracts/common/lib/GIndex.sol";
import {PredepositGuarantee} from "contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee.sol";

contract PredepositGuarantee_HarnessForFactory is PredepositGuarantee {
    constructor(
        bytes4 _genesisForkVersion,
        GIndex _gIFirstValidator,
        GIndex _gIFirstValidatorAfterChange,
        uint64 _changeSlot
    ) PredepositGuarantee(_genesisForkVersion, _gIFirstValidator, _gIFirstValidatorAfterChange, _changeSlot) {}
}
