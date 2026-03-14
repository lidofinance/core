// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {OmnibusBase} from "./utils/OmnibusBase.sol";
import {UpgradeTemplate} from "./UpgradeTemplate.sol";
import {VoteScriptHelpers} from "./utils/VoteScriptHelpers.sol";
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
    uint256 public constant DG_ITEMS_COUNT = 71;
    uint256 public constant VOTING_ITEMS_COUNT = 10;

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

    function getVotingVoteItems() public view override returns (VoteItem[] memory votingVoteItems) {
        GeneralConfig memory g = TEMPLATE.getGeneralConfig();
        CoreUpgradeConfig memory c = TEMPLATE.getCoreUpgradeConfig();

        votingVoteItems = new VoteItem[](VOTING_ITEMS_COUNT);

        uint256 index = 0;

        votingVoteItems[index++] = VoteScriptHelpers.item({
            description: "2. Add UpdateStakingModuleShareLimits factory to Easy Track (permissions: stakingRouter, updateModuleShares)", // 1 is reserved for DG submission item
            to: g.easyTrack,
            data: abi.encodeCall(
                IEasyTrack.addEVMScriptFactory,
                (
                    c.etfUpdateStakingModuleShareLimits,
                    bytes.concat(bytes20(g.stakingRouter), bytes4(IStakingRouter.updateModuleShares.selector))
                )
            )
        });

        votingVoteItems[index++] = VoteScriptHelpers.item({
            description: "3. Add AllowConsolidationPair factory to Easy Track",
            to: g.easyTrack,
            data: abi.encodeCall(
                IEasyTrack.addEVMScriptFactory,
                (
                    c.etfAllowConsolidationPair,
                    bytes.concat(bytes20(c.consolidationMigrator), bytes4(IConsolidationMigrator.allowPair.selector))
                )
            )
        });

        assert(index == VOTING_ITEMS_COUNT);
    }

    function getVoteItems() public view override returns (VoteItem[] memory voteItems) {
        CoreUpgradeConfig memory c = TEMPLATE.getCoreUpgradeConfig();

        voteItems = new VoteItem[](DG_ITEMS_COUNT);

        uint256 index = 0;

        voteItems[index++] = VoteScriptHelpers.item({
            description: "1.1. Ensure DG proposal execution is within daily time window (14:00 UTC - 23:00 UTC)",
            to: params.timeConstraints,
            data: abi.encodeCall(
                ITimeConstraints.checkTimeWithinDayTimeAndEmit, (ENABLED_DAY_SPAN_START, ENABLED_DAY_SPAN_END)
            )
        });

        voteItems[index++] = _itemAsAgent({
            description: "1.2. Call UpgradeTemplate.startUpgrade",
            to: address(TEMPLATE),
            data: abi.encodeCall(UpgradeTemplate.startUpgrade, ())
        });

        voteItems[index++] = _itemAsAgent({
            description: "1.3. Upgrade LidoLocator implementation",
            to: c.locator,
            data: abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (c.newLocatorImpl))
        });

        voteItems[index++] = _itemAsAgent({
            description: "1.4.1. Grant Aragon APP_MANAGER_ROLE to the AGENT",
            to: c.acl,
            data: abi.encodeCall(IACL.grantPermission, (AGENT, c.kernel, keccak256("APP_MANAGER_ROLE")))
        });

        voteItems[index++] = _itemAsAgent({
            description: "1.4.2. Set Lido implementation in Kernel",
            to: c.kernel,
            data: abi.encodeCall(IKernel.setApp, (IKernel(c.kernel).APP_BASES_NAMESPACE(), c.lidoAppId, c.newLidoImpl))
        });

        voteItems[index++] = _itemAsAgent({
            description: "1.4.3. Revoke Aragon APP_MANAGER_ROLE from the AGENT",
            to: c.acl,
            data: abi.encodeCall(IACL.revokePermission, (AGENT, c.kernel, keccak256("APP_MANAGER_ROLE")))
        });

        index = _mergeItemsAgentForwarded(CoreUpgradeItems.getItems(TEMPLATE), voteItems, index);

        //
        // CSM upgrade & CMv2
        //
        index = _mergeItemsAgentForwarded(CSMUpgradeItems.getItems(TEMPLATE), voteItems, index);
        index = _mergeItemsAgentForwarded(CuratedModuleItems.getItems(TEMPLATE), voteItems, index);

        //
        // Template: finish upgrade
        //

        voteItems[index++] = _itemAsAgent({
            description: "1.8. Call UpgradeTemplate.finishUpgrade",
            to: params.upgradeTemplate,
            data: abi.encodeCall(UpgradeTemplate.finishUpgrade, ())
        });

        assert(index == DG_ITEMS_COUNT);
    }

    function _mergeItemsAgentForwarded(VoteItem[] memory src, VoteItem[] memory dst, uint256 index)
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

    function _itemFwd(address forwarder, VoteItem memory voteItem) internal pure returns (VoteItem memory) {
        voteItem.call = _forwardCall(forwarder, voteItem.call.to, voteItem.call.data);
        return voteItem;
    }

    function _itemFwd(address forwarder, string memory description, address to, bytes memory data)
        internal
        pure
        returns (VoteItem memory)
    {
        return VoteScriptHelpers.item(description, _forwardCall(forwarder, to, data));
    }

    /// ---

    // function _item(string memory description, ScriptCall memory call) private pure returns (VoteItem memory) {
    //     return VoteItem({description: description, call: call});
    // }

    // function _item(string memory description, address to, bytes memory data) private pure returns (VoteItem memory) {
    //     return _item(description, ScriptCall({to: to, data: data}));
    // }

    function _itemAsAgent(string memory description, address to, bytes memory data)
        private
        view
        returns (VoteItem memory)
    {
        return VoteScriptHelpers.item(description, _forwardCall(AGENT, to, data));
    }
}
