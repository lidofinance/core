// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import {V3Template} from "contracts/upgrade/V3Template.sol";

contract V3Template__Harness {
    V3Template public immutable TEMPLATE;

    constructor(address _template) {
        TEMPLATE = V3Template(_template);
    }

    function startUpgradeTwice() external {
        TEMPLATE.startUpgrade();
        TEMPLATE.startUpgrade();
    }
}
