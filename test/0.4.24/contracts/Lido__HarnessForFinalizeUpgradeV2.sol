// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Lido} from "contracts/0.4.24/Lido.sol";

contract Lido__HarnessForFinalizeUpgradeV3 is Lido {
    function harness_setContractVersion(uint256 _version) external {
        _setContractVersion(_version);
    }
}
