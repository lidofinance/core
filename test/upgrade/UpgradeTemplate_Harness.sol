// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import {UpgradeTemplate} from "contracts/upgrade/UpgradeTemplate.sol";

contract UpgradeTemplate_Harness {
    UpgradeTemplate public immutable TEMPLATE;

    constructor(address _template) {
        TEMPLATE = UpgradeTemplate(_template);
    }

    function startUpgradeTwice() external {
        TEMPLATE.startUpgrade();
        TEMPLATE.startUpgrade();
    }
}
