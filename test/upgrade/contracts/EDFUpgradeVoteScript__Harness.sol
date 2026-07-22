// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {EDFUpgradeVoteScript} from "contracts/upgrade/EDFUpgradeVoteScript.sol";

contract EDFUpgradeVoteScript__Harness is EDFUpgradeVoteScript {
    constructor(ScriptParams memory params) EDFUpgradeVoteScript(params) {}

    function getInnerVoteItems() external view returns (VoteItem[] memory) {
        return _getVoteItems();
    }
}
