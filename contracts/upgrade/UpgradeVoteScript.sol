// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {OmnibusBase} from "./utils/OmnibusBase.sol";
import {UpgradeTemplate} from "./UpgradeTemplate.sol";
import {VoteScriptHelpers} from "./utils/VoteScriptHelpers.sol";
import {EasyTrackFactoryItems} from "./include/EasyTrackFactoryItems.sol";
import {CoreUpgradeItems} from "./include/CoreUpgradeItems.sol";
import {CSMUpgradeItems} from "./include/CSMUpgradeItems.sol";
import {CuratedModuleItems} from "./include/CuratedModuleItems.sol";

import {
    ITimeConstraints,
    GeneralConfig,
    CoreUpgradeConfig,
    IKernel,
    IACL,
    IEasyTrack,
    IStakingRouter,
    IConsolidationMigrator
} from "./UpgradeTypes.sol";

/// @title UpgradeVoteScript
/// @notice Script for upgrading Lido protocol components
contract UpgradeVoteScript is OmnibusBase {
    uint32 public constant ENABLED_DAY_SPAN_START = 50400; // 14:00 UTC
    uint32 public constant ENABLED_DAY_SPAN_END = 82800; // 23:00 UTC

    struct ScriptParams {
        address upgradeTemplate;
        address timeConstraints;
    }

    //
    // Constants
    //
    // TODO set upon finish with items
    uint256 public constant DG_ITEMS_COUNT = 71;
    uint256 public constant VOTING_ITEMS_COUNT = 2;

    //
    // Immutables
    //
    UpgradeTemplate public immutable TEMPLATE;
    address internal immutable AGENT;

    //
    // Structured storage
    //
    ScriptParams public params;

    constructor(ScriptParams memory _params)
        OmnibusBase(
            UpgradeTemplate(_params.upgradeTemplate).VOTING(),
            UpgradeTemplate(_params.upgradeTemplate).DUAL_GOVERNANCE()
        )
    {
        TEMPLATE = UpgradeTemplate(_params.upgradeTemplate);
        AGENT = TEMPLATE.AGENT();
        params = _params;
    }

    /// @dev Non DG voting items
    function getVotingVoteItems() public view override returns (VoteItem[] memory votingVoteItems) {
        votingVoteItems = new VoteItem[](VOTING_ITEMS_COUNT);
        uint256 index = 0;

        //
        // Add new EasyTrack Factories
        //
        index = _mergeItems(EasyTrackFactoryItems.getItems(TEMPLATE), votingVoteItems, index);

        assert(index == VOTING_ITEMS_COUNT);
    }

    /// @dev DG voting items
    function getVoteItems() public view override returns (VoteItem[] memory voteItems) {
        voteItems = new VoteItem[](DG_ITEMS_COUNT);
        uint256 index = 0;

        voteItems[index++] = VoteScriptHelpers.item({
            description: "Ensure DG proposal execution is within daily time window (14:00 UTC - 23:00 UTC)",
            to: params.timeConstraints,
            data: abi.encodeCall(
                ITimeConstraints.checkTimeWithinDayTimeAndEmit, (ENABLED_DAY_SPAN_START, ENABLED_DAY_SPAN_END)
            )
        });

        voteItems[index++] = _itemAsAgent({
            description: "Call UpgradeTemplate.startUpgrade",
            to: address(TEMPLATE),
            data: abi.encodeCall(UpgradeTemplate.startUpgrade, ())
        });

        //
        // Core upgrade
        //
        index = _mergeItemsAsAgent(CoreUpgradeItems.getItems(TEMPLATE), voteItems, index);

        //
        // CSM upgrade & CMv2
        //
        index = _mergeItemsAsAgent(CSMUpgradeItems.getItems(TEMPLATE), voteItems, index);
        index = _mergeItemsAsAgent(CuratedModuleItems.getItems(TEMPLATE), voteItems, index);

        //
        // Template: finish upgrade
        //

        voteItems[index++] = _itemAsAgent({
            description: "Call UpgradeTemplate.finishUpgrade",
            to: params.upgradeTemplate,
            data: abi.encodeCall(UpgradeTemplate.finishUpgrade, ())
        });

        assert(index == DG_ITEMS_COUNT);
    }

    //
    // Helpers
    //

    /// @dev Wrap item with forward to AGENT
    function _itemAsAgent(string memory description, address to, bytes memory data)
        private
        view
        returns (VoteItem memory)
    {
        return _itemFwd(AGENT, description, to, data);
    }

    /// @dev Merge items from src to dst starting at index wrapped with forward to AGENT
    function _mergeItemsAsAgent(VoteItem[] memory src, VoteItem[] memory dst, uint256 index)
        internal
        view
        returns (uint256)
    {
        for (uint256 i = 0; i < src.length; ++i) {
            dst[index++] = _itemFwd(AGENT, src[i]);
        }
        return index;
    }

    function _mergeItems(VoteItem[] memory src, VoteItem[] memory dst, uint256 index) internal pure returns (uint256) {
        for (uint256 i = 0; i < src.length; ++i) {
            dst[index++] = src[i];
        }
        return index;
    }

    function _itemFwd(address forwarder, string memory description, address to, bytes memory data)
        internal
        pure
        returns (VoteItem memory)
    {
        return VoteScriptHelpers.item(description, _forwardCall(forwarder, to, data));
    }

    function _itemFwd(address forwarder, VoteItem memory voteItem) internal pure returns (VoteItem memory) {
        voteItem.call = _forwardCall(forwarder, voteItem.call.to, voteItem.call.data);
        return voteItem;
    }
}
