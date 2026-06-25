// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {UpgradeVoteScript} from "contracts/upgrade/UpgradeVoteScript.sol";
import {
    UpgradeVoteScript__Harness,
    UpgradeConfig__MockForVoteScript,
    UpgradeTemplate__MockForVoteScript
} from "./contracts/UpgradeVoteScript__Harness.sol";

/// @notice Pointed test for the vote-item count guard of `UpgradeVoteScript`.
/// @dev Uses a mock `UpgradeConfig`/`UpgradeTemplate` so the whole config does not need to be populated.
///      The item builders are linear, so zero-valued config still produces the full item set.
contract UpgradeVoteScriptCountTest is Test {
    UpgradeVoteScript__Harness internal script;

    function setUp() public {
        UpgradeConfig__MockForVoteScript config = new UpgradeConfig__MockForVoteScript({
            voting: makeAddr("voting"),
            dualGovernance: makeAddr("dualGovernance"),
            agent: makeAddr("agent")
        });
        UpgradeTemplate__MockForVoteScript template = new UpgradeTemplate__MockForVoteScript(address(config));

        script = new UpgradeVoteScript__Harness(UpgradeVoteScript.ScriptParams({upgradeTemplate: address(template)}));
    }

    /// @notice Prints actual vs declared item counts. Run with `-vv` to read them off; if you changed
    ///         the item lists, copy the actual numbers into DG_ITEMS_COUNT / VOTING_ITEMS_COUNT.
    function test_logVoteItemsCount() public view {
        console2.log("DG     items: actual=%s declared=%s", script.harness__dgItemsCount(), script.DG_ITEMS_COUNT());
        console2.log(
            "Voting items: actual=%s declared=%s",
            script.harness__votingItemsCount(),
            script.VOTING_ITEMS_COUNT()
        );
    }

    /// @notice Fails with a readable diff (e.g. `73 != 72`) the moment the item lists drift,
    ///         giving you the exact number to set — no manual counting.
    function test_voteItemsCountMatchesConstants() public view {
        assertEq(
            script.harness__dgItemsCount(),
            script.DG_ITEMS_COUNT(),
            "DG item count drifted; update DG_ITEMS_COUNT"
        );
        assertEq(
            script.harness__votingItemsCount(),
            script.VOTING_ITEMS_COUNT(),
            "Voting item count drifted; update VOTING_ITEMS_COUNT"
        );
    }
}
