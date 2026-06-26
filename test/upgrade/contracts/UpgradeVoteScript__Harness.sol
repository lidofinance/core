// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {UpgradeVoteScript} from "contracts/upgrade/UpgradeVoteScript.sol";
import {OmnibusBase} from "contracts/upgrade/utils/OmnibusBase.sol";
import {
    GlobalConfig,
    CoreUpgradeConfig,
    CSMUpgradeConfig,
    CuratedModuleConfig,
    EasyTrackNewFactories,
    EasyTrackOldFactories
} from "contracts/upgrade/UpgradeTypes.sol";

/// @notice Minimal stand-in for `UpgradeConfig`. `_buildVoteItems`/`_buildVotingVoteItems` are linear
///         (every `items[i++]` runs unconditionally) and only feed config addresses into `abi.encodeCall`,
///         so all-zero structs are enough to exercise the full item-building path. Empty `curatedGates`/
///         `csmGates` arrays also keep the merkle-gate loop a no-op (no `InvalidMerkleGateAddress`).
/// @dev Matches the selectors `UpgradeVoteScript` calls on `UpgradeConfig(CONFIG)`; it does not inherit
///      the real contract, so no heavy constructor wiring is needed.
contract UpgradeConfig__MockForVoteScript {
    address public immutable LOCATOR;
    address public immutable AGENT;
    address public immutable VOTING;
    address public immutable DUAL_GOVERNANCE;

    constructor(address voting, address dualGovernance, address agent) {
        VOTING = voting;
        DUAL_GOVERNANCE = dualGovernance;
        AGENT = agent;
        LOCATOR = address(0);
    }

    function getGlobalConfig() external pure returns (GlobalConfig memory g) {}

    function getCoreUpgradeConfig() external pure returns (CoreUpgradeConfig memory c) {}

    function getCSMUpgradeConfig() external pure returns (CSMUpgradeConfig memory c) {
        // The voting items build a merkle-gate list from these two and reject address(0),
        // so they must be non-zero; every other field can stay zero.
        c.vettedGate = address(uint160(0x9a7e0001));
        c.identifiedDVTClusterGate = address(uint160(0x9a7e0002));
    }

    function getCuratedModuleConfig() external pure returns (CuratedModuleConfig memory c) {}

    function getEasyTrackConfig()
        external
        pure
        returns (EasyTrackNewFactories memory n, EasyTrackOldFactories memory o)
    {}
}

/// @notice Minimal stand-in for `UpgradeTemplate` — the script only reads `CONFIG()` from it
///         (`startUpgrade`/`finishUpgrade` are merely `abi.encodeCall`-encoded, never invoked).
contract UpgradeTemplate__MockForVoteScript {
    address public immutable CONFIG;

    constructor(address config) {
        CONFIG = config;
    }
}

/// @notice Test harness exposing the count-building internals of `UpgradeVoteScript`.
/// @dev `harness__*Count` call the non-asserting builders, so the test reads the *actual* item
///      count even when it diverges from DG_ITEMS_COUNT / VOTING_ITEMS_COUNT — which is exactly
///      the number you'd otherwise have to count by hand.
contract UpgradeVoteScript__Harness is UpgradeVoteScript {
    constructor(ScriptParams memory _params) UpgradeVoteScript(_params) {}

    function harness__dgItemsCount() external view returns (uint256) {
        return _getVoteItems().length;
    }

    function harness__votingItemsCount() external view returns (uint256) {
        return _getVotingVoteItems().length;
    }
}
