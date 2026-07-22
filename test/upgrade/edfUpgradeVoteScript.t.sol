// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";

import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {EDFUpgradeTemplate} from "contracts/upgrade/EDFUpgradeTemplate.sol";
import {EDFUpgradeVoteScript} from "contracts/upgrade/EDFUpgradeVoteScript.sol";
import {IEDFHashConsensus} from "contracts/upgrade/EDFUpgradeTypes.sol";
import {ExternalCall, IDualGovernance} from "contracts/upgrade/interfaces/IDualGovernance.sol";
import {IForwarder} from "contracts/upgrade/interfaces/IForwarder.sol";
import {IVoting} from "contracts/upgrade/interfaces/IVoting.sol";
import {CallsScriptBuilder} from "contracts/upgrade/utils/CallScriptBuilder.sol";
import {OmnibusBase} from "contracts/upgrade/utils/OmnibusBase.sol";

import {EDFUpgradeTestBase} from "./contracts/EDFUpgradeTestBase.sol";
import {EDFUpgradeVoteScript__Harness} from "./contracts/EDFUpgradeVoteScript__Harness.sol";

contract EDFUpgradeVoteScriptTest is Test, EDFUpgradeTestBase {
    using CallsScriptBuilder for CallsScriptBuilder.Context;

    bytes32 internal constant UNVET_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");
    address internal constant AGENT = address(0xA001);

    EDFUpgradeTemplate internal template;
    EDFUpgradeVoteScript__Harness internal voteScript;

    function setUp() public {
        template = new EDFUpgradeTemplate(_makeParams(AGENT), block.timestamp + 30 days);
        voteScript = new EDFUpgradeVoteScript__Harness(
            EDFUpgradeVoteScript.ScriptParams({upgradeTemplate: address(template)})
        );
    }

    function test_declaredCountsAndSinglePackedDGItem() public view {
        assertEq(voteScript.getVotingVoteItems().length, voteScript.VOTING_ITEMS_COUNT());
        assertEq(voteScript.VOTING_ITEMS_COUNT(), 0);
        assertEq(voteScript.getVoteItems().length, voteScript.DG_ITEMS_COUNT());
        assertEq(voteScript.DG_ITEMS_COUNT(), 1);
        assertEq(voteScript.getInnerVoteItems().length, voteScript.rawActionsCount());
        assertEq(voteScript.rawActionsCount(), 85);

        OmnibusBase.VoteItem[] memory dgItems = voteScript.getVoteItems();
        assertEq(dgItems[0].description, "1. Submit the EDF/DSM v5 upgrade to Dual Governance");
        assertEq(dgItems[0].call.to, AGENT);
        assertEq(dgItems[0].call.data, abi.encodeCall(IForwarder.forward, (_expectedInnerScript())));
    }

    function test_exactRawActionsOrderTargetsCalldataAndDescriptions() public view {
        OmnibusBase.VoteItem[] memory items = voteScript.getVoteItemsRaw();
        assertEq(items.length, 85);
        _assertItem(
            items[0],
            "1.1. Call EDFUpgradeTemplate.startUpgrade",
            address(template),
            abi.encodeCall(EDFUpgradeTemplate.startUpgrade, ())
        );

        uint256 itemIndex = 1;
        for (uint256 committeeIndex = 0; committeeIndex < COMMITTEES_COUNT; ++committeeIndex) {
            address consensus = _consensusContract(committeeIndex);
            for (uint256 mappingIndex = 0; mappingIndex < ORACLE_MEMBERS_COUNT; ++mappingIndex) {
                uint256 memberIndex = _oracleMemberIndex(committeeIndex, mappingIndex);
                address oldMember = _oldOracleMember(memberIndex);
                address newMember = _delegationContract(GUARDIANS_COUNT + memberIndex);
                string memory itemSuffix = string.concat(
                    vm.toString(committeeIndex + 1),
                    ".",
                    vm.toString(mappingIndex + 1)
                );
                string memory prefix = string.concat("1.", vm.toString(itemIndex + 1), ". ");
                _assertItem(
                    items[itemIndex++],
                    string.concat(prefix, "Remove old oracle member ", itemSuffix),
                    consensus,
                    abi.encodeCall(IEDFHashConsensus.removeMember, (oldMember, 6))
                );
                prefix = string.concat("1.", vm.toString(itemIndex + 1), ". ");
                _assertItem(
                    items[itemIndex++],
                    string.concat(prefix, "Add EDF oracle member ", itemSuffix),
                    consensus,
                    abi.encodeCall(IEDFHashConsensus.addMember, (newMember, 6))
                );
            }
        }

        _assertItem(
            items[itemIndex++],
            "1.82. Upgrade LidoLocator implementation",
            LOCATOR,
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (NEW_LOCATOR_IMPLEMENTATION))
        );
        _assertItem(
            items[itemIndex++],
            "1.83. Revoke the old DSM unvetting role",
            STAKING_ROUTER,
            abi.encodeCall(IAccessControl.revokeRole, (UNVET_ROLE, OLD_DSM))
        );
        _assertItem(
            items[itemIndex++],
            "1.84. Grant the new DSM unvetting role",
            STAKING_ROUTER,
            abi.encodeCall(IAccessControl.grantRole, (UNVET_ROLE, NEW_DSM))
        );
        _assertItem(
            items[itemIndex++],
            "1.85. Call EDFUpgradeTemplate.finishUpgrade",
            address(template),
            abi.encodeCall(EDFUpgradeTemplate.finishUpgrade, ())
        );
        assertEq(itemIndex, items.length);
    }

    function test_exactNewVoteBytecodeSnapshot() public view {
        string memory voteDescription = "EDF/DSM v5 upgrade";
        string memory proposalMetadata = "ipfs://edf-upgrade";

        ExternalCall[] memory proposalCalls = new ExternalCall[](1);
        proposalCalls[0] = ExternalCall({
            target: AGENT,
            value: 0,
            payload: abi.encodeCall(IForwarder.forward, (_expectedInnerScript()))
        });
        bytes memory expectedEVMScript = CallsScriptBuilder
            .create(DUAL_GOVERNANCE, abi.encodeCall(IDualGovernance.submitProposal, (proposalCalls, proposalMetadata)))
            .getResult();
        bytes memory expectedNewVoteBytecode = CallsScriptBuilder
            .create(VOTING, abi.encodeCall(IVoting.newVote, (expectedEVMScript, voteDescription, false, false)))
            .getResult();

        assertEq(voteScript.getEVMScript(proposalMetadata), expectedEVMScript);
        assertEq(voteScript.getNewVoteCallBytecode(voteDescription, proposalMetadata), expectedNewVoteBytecode);
    }

    function _expectedInnerScript() private view returns (bytes memory) {
        CallsScriptBuilder.Context memory innerScript = CallsScriptBuilder.create();
        innerScript.addCall(address(template), abi.encodeCall(EDFUpgradeTemplate.startUpgrade, ()));

        for (uint256 committeeIndex = 0; committeeIndex < COMMITTEES_COUNT; ++committeeIndex) {
            address consensus = _consensusContract(committeeIndex);
            for (uint256 mappingIndex = 0; mappingIndex < ORACLE_MEMBERS_COUNT; ++mappingIndex) {
                uint256 memberIndex = _oracleMemberIndex(committeeIndex, mappingIndex);
                innerScript.addCall(
                    consensus,
                    abi.encodeCall(IEDFHashConsensus.removeMember, (_oldOracleMember(memberIndex), 6))
                );
                innerScript.addCall(
                    consensus,
                    abi.encodeCall(IEDFHashConsensus.addMember, (_delegationContract(GUARDIANS_COUNT + memberIndex), 6))
                );
            }
        }

        innerScript.addCall(LOCATOR, abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (NEW_LOCATOR_IMPLEMENTATION)));
        innerScript.addCall(STAKING_ROUTER, abi.encodeCall(IAccessControl.revokeRole, (UNVET_ROLE, OLD_DSM)));
        innerScript.addCall(STAKING_ROUTER, abi.encodeCall(IAccessControl.grantRole, (UNVET_ROLE, NEW_DSM)));
        innerScript.addCall(address(template), abi.encodeCall(EDFUpgradeTemplate.finishUpgrade, ()));
        return innerScript.getResult();
    }

    function _assertItem(
        OmnibusBase.VoteItem memory item,
        string memory description,
        address target,
        bytes memory data
    ) private pure {
        assertEq(item.description, description);
        assertEq(item.call.to, target);
        assertEq(item.call.data, data);
    }
}
