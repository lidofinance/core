// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {IForwarder} from "../interfaces/IForwarder.sol";
import {IVoting} from "../interfaces/IVoting.sol";
import {IDualGovernance, ExternalCall} from "../interfaces/IDualGovernance.sol";

import {CallsScriptBuilder} from "./CallScriptBuilder.sol";


/// @title OmnibusBase
/// @notice Abstract base contract for creating votes for the Aragon Voting.
///
/// @dev Originates from https://github.com/lidofinance/dual-governance/tree/98216fb2c9150b8111a14b06afd9d6e646f14c20/scripts/upgrade
/// @dev The OmnibusBase contract serves as a foundational layer for creating governance proposals
///     that are compatible with the Aragon Voting framework. It provides a structured approach
///     to define and execute a series of actions (vote items) within a single governance vote.
///     The contract leverages the CallsScriptBuilder library to construct EVM call scripts,
///     ensuring that all actions are executed atomically and in the specified order.
/// @dev This contract is designed to be extended and customized for specific governance
///     scenarios, allowing developers to define complex multi-step proposals that can be
///     executed within the Aragon governance ecosystem.
/// @dev Inheriting contracts are expected to implement the `getVoteItems()` function, which
///     outlines the specific actions to be included in the governance proposal. These actions
///     are encapsulated in the `VoteItem` struct, which includes a human-readable description
///     and the necessary EVM call data.
abstract contract OmnibusBase {
    using CallsScriptBuilder for CallsScriptBuilder.Context;

    struct ScriptCall {
        address to;
        bytes data;
    }

    /// @notice A structure that represents a single voting item in a governance proposal.
    /// @dev This struct is designed to match the format required by the Lido scripts repository
    ///     for compatibility with the voting tooling.
    /// @param description Human-readable description of the voting item.
    /// @param call The EVM script call containing the target contract address and calldata.
    struct VoteItem {
        string description;
        ScriptCall call;
    }

    IVoting internal immutable VOTING_CONTRACT;
    IDualGovernance internal immutable DUAL_GOVERNANCE;

    constructor(address voting, address dualGovernance) {
        VOTING_CONTRACT = IVoting(voting);
        DUAL_GOVERNANCE = IDualGovernance(dualGovernance);
    }

    /// @return VoteItem[] The list of items to be executed by Dual Governance.
    function getVoteItems() public view virtual returns (VoteItem[] memory);

    /// @return VoteItem[] The list of voting items to be executed by Aragon Voting.
    function getVotingVoteItems() public view virtual returns (VoteItem[] memory);

    /// @notice Converts all vote items to the Aragon-compatible EVMCallScript to validate against.
    /// @param proposalMetadata The metadata of the proposal.
    /// @return script A bytes containing encoded EVMCallScript.
    function getEVMScript(string memory proposalMetadata) public view returns (bytes memory) {
        VoteItem[] memory dgVoteItems = this.getVoteItems();
        ExternalCall[] memory dgCalls = new ExternalCall[](dgVoteItems.length);
        for (uint256 i = 0; i < dgVoteItems.length; i++) {
            dgCalls[i] = ExternalCall({
                target: dgVoteItems[i].call.to,
                value: 0,
                payload: dgVoteItems[i].call.data
            });
        }

        CallsScriptBuilder.Context memory scriptBuilder = CallsScriptBuilder.create();

        scriptBuilder.addCall(address(DUAL_GOVERNANCE), abi.encodeCall(IDualGovernance.submitProposal, (dgCalls, proposalMetadata)));

        VoteItem[] memory votingVoteItems = this.getVotingVoteItems();
        for (uint256 i = 0; i < votingVoteItems.length; i++) {
            scriptBuilder.addCall(votingVoteItems[i].call.to, votingVoteItems[i].call.data);
        }

        return scriptBuilder.getResult();
    }

    /// @notice Returns the bytecode for creating a new vote on the Aragon Voting contract.
    /// @param description The description of the vote.
    /// @param proposalMetadata The metadata of the proposal.
    /// @return newVoteBytecode The bytecode for creating a new vote.
    function getNewVoteCallBytecode(string memory description, string memory proposalMetadata) external view returns (bytes memory newVoteBytecode) {
        newVoteBytecode = CallsScriptBuilder.create(
            address(VOTING_CONTRACT), abi.encodeCall(VOTING_CONTRACT.newVote, (getEVMScript(proposalMetadata), description, false, false))
        )._result;
    }

    /// @notice Validates the specific vote on Aragon Voting contract.
    /// @param voteId The ID of the vote.
    /// @param proposalMetadata The metadata of the proposal.
    /// @return A boolean value indicating whether the vote is valid.
    function isValidVoteScript(uint256 voteId, string memory proposalMetadata) external view returns (bool) {
        ( /*open*/
            , /*executed*/
            , /*startDate*/
            , /*snapshotBlock*/
            , /*supportRequired*/
            , /*minAcceptQuorum*/
            , /*yea*/
            , /*nay*/
            , /*votingPower*/
            ,
            bytes memory script,
            /*phase*/
        ) = VOTING_CONTRACT.getVote(voteId);
        return keccak256(script) == keccak256(getEVMScript(proposalMetadata));
    }

    function _votingCall(address target, bytes memory data) internal pure returns (ScriptCall memory) {
        return ScriptCall(target, data);
    }

    function _forwardCall(
        address forwarder,
        address target,
        bytes memory data
    ) internal pure returns (ScriptCall memory) {
        return ScriptCall(
            forwarder, abi.encodeCall(IForwarder.forward, (CallsScriptBuilder.create(target, data).getResult()))
        );
    }
}
