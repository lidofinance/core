// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";
import {Strings} from "@openzeppelin/contracts-v5.2/utils/Strings.sol";

import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {EDFUpgradeConfig} from "./EDFUpgradeConfig.sol";
import {EDFUpgradeTemplate} from "./EDFUpgradeTemplate.sol";
import {IEDFHashConsensus} from "./EDFUpgradeTypes.sol";
import {IForwarder} from "./interfaces/IForwarder.sol";
import {CallsScriptBuilder} from "./utils/CallScriptBuilder.sol";
import {OmnibusBase} from "./utils/OmnibusBase.sol";

/// @title EDFUpgradeVoteScript
/// @notice Builds the atomic EDF/DSM v5 upgrade proposal.
contract EDFUpgradeVoteScript is OmnibusBase {
    using CallsScriptBuilder for CallsScriptBuilder.Context;
    using Strings for uint256;

    error InvalidItemsCount(uint256 actual, uint256 expected);

    uint256 public constant DG_ITEMS_COUNT = 1;
    uint256 public constant VOTING_ITEMS_COUNT = 0;
    bytes32 internal constant STAKING_MODULE_UNVETTING_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");

    address public immutable TEMPLATE;
    address public immutable CONFIG;
    address internal immutable AGENT;

    struct ScriptParams {
        address upgradeTemplate;
    }

    constructor(ScriptParams memory params)
        OmnibusBase(
            EDFUpgradeConfig(EDFUpgradeTemplate(params.upgradeTemplate).CONFIG()).VOTING(),
            EDFUpgradeConfig(EDFUpgradeTemplate(params.upgradeTemplate).CONFIG()).DUAL_GOVERNANCE()
        )
    {
        EDFUpgradeTemplate template = EDFUpgradeTemplate(params.upgradeTemplate);
        EDFUpgradeConfig config = EDFUpgradeConfig(template.CONFIG());
        TEMPLATE = address(template);
        CONFIG = address(config);
        AGENT = config.AGENT();
    }

    function getVotingVoteItems() public pure override returns (VoteItem[] memory items) {
        items = new VoteItem[](VOTING_ITEMS_COUNT);
    }

    function getVoteItemsRaw() external view returns (VoteItem[] memory) {
        VoteItem[] memory items = _getVoteItems();
        for (uint256 i = 0; i < items.length; ++i) {
            items[i].description = string.concat("1.", (i + 1).toString(), ". ", items[i].description);
        }
        return items;
    }

    function getVoteItems() public view override returns (VoteItem[] memory items) {
        VoteItem[] memory rawItems = _getVoteItems();
        CallsScriptBuilder.Context memory scriptBuilder = CallsScriptBuilder.create();
        for (uint256 i = 0; i < rawItems.length; ++i) {
            scriptBuilder.addCall(rawItems[i].call.to, rawItems[i].call.data);
        }

        items = new VoteItem[](DG_ITEMS_COUNT);
        items[0] = VoteItem({
            description: "1. Submit the EDF/DSM v5 upgrade to Dual Governance",
            call: _votingCall(AGENT, abi.encodeCall(IForwarder.forward, (scriptBuilder.getResult())))
        });
    }

    function rawActionsCount() public view returns (uint256) {
        return 5 + 2 * EDFUpgradeConfig(CONFIG).oracleMappingsCount();
    }

    function _getVoteItems() internal view returns (VoteItem[] memory items) {
        EDFUpgradeConfig config = EDFUpgradeConfig(CONFIG);
        uint256 expectedCount = rawActionsCount();
        items = new VoteItem[](expectedCount);
        uint256 itemIndex;

        items[itemIndex++] = _item(
            "Call EDFUpgradeTemplate.startUpgrade",
            TEMPLATE,
            abi.encodeCall(EDFUpgradeTemplate.startUpgrade, ())
        );

        uint256 committeesCount = config.oracleCommitteesCount();
        for (uint256 committeeIndex = 0; committeeIndex < committeesCount; ++committeeIndex) {
            (address consensusContract, uint256 quorum) = config.oracleCommittee(committeeIndex);
            uint256 mappingsCount = config.oracleCommitteeMappingsCount(committeeIndex);
            for (uint256 mappingIndex = 0; mappingIndex < mappingsCount; ++mappingIndex) {
                (address oldMember, address newMember) =
                    config.oracleCommitteeMapping(committeeIndex, mappingIndex);
                string memory itemSuffix =
                    string.concat((committeeIndex + 1).toString(), ".", (mappingIndex + 1).toString());

                items[itemIndex++] = _item(
                    string.concat("Remove old oracle member ", itemSuffix),
                    consensusContract,
                    abi.encodeCall(IEDFHashConsensus.removeMember, (oldMember, quorum))
                );
                items[itemIndex++] = _item(
                    string.concat("Add EDF oracle member ", itemSuffix),
                    consensusContract,
                    abi.encodeCall(IEDFHashConsensus.addMember, (newMember, quorum))
                );
            }
        }

        items[itemIndex++] = _item(
            "Upgrade LidoLocator implementation",
            config.LOCATOR(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_LOCATOR_IMPLEMENTATION()))
        );
        items[itemIndex++] = _item(
            "Revoke the old DSM unvetting role",
            config.STAKING_ROUTER(),
            abi.encodeCall(
                IAccessControl.revokeRole, (STAKING_MODULE_UNVETTING_ROLE, config.OLD_DEPOSIT_SECURITY_MODULE())
            )
        );
        items[itemIndex++] = _item(
            "Grant the new DSM unvetting role",
            config.STAKING_ROUTER(),
            abi.encodeCall(
                IAccessControl.grantRole, (STAKING_MODULE_UNVETTING_ROLE, config.NEW_DEPOSIT_SECURITY_MODULE())
            )
        );
        items[itemIndex++] = _item(
            "Call EDFUpgradeTemplate.finishUpgrade",
            TEMPLATE,
            abi.encodeCall(EDFUpgradeTemplate.finishUpgrade, ())
        );

        if (itemIndex != expectedCount) revert InvalidItemsCount(itemIndex, expectedCount);
    }

    function _item(string memory description, address to, bytes memory data) private pure returns (VoteItem memory) {
        return VoteItem({description: description, call: _votingCall(to, data)});
    }
}
