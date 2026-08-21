// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {EDFUpgradeTemplate} from "contracts/upgrade/EDFUpgradeTemplate.sol";
import {EDFUpgradeParameters} from "contracts/upgrade/EDFUpgradeTypes.sol";

/// @dev Constructor wrapper only. Production pre/post validation is intentionally not overridden.
contract EDFUpgradeTemplate__Harness is EDFUpgradeTemplate {
    constructor(
        EDFUpgradeParameters memory params,
        uint256 expireSinceInclusive
    ) EDFUpgradeTemplate(params, expireSinceInclusive) {}
}
