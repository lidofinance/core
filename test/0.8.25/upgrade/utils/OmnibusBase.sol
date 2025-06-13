// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IForwarder} from "../interfaces/IForwarder.sol";
import {IVoting} from "../interfaces/IVoting.sol";

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

    IVoting private immutable VOTING_CONTRACT;

    constructor(address voting) {
        VOTING_CONTRACT = IVoting(voting);
    }

    /// @return VoteItem[] The list of voting items to be executed by Aragon Voting.
    function getVoteItems() public view virtual returns (VoteItem[] memory);

    /// @notice Converts all vote items to the Aragon-compatible EVMCallScript to validate against.
    /// @return script A bytes containing encoded EVMCallScript.
    function getEVMScript() public view returns (bytes memory) {
        CallsScriptBuilder.Context memory scriptBuilder = CallsScriptBuilder.create();
        VoteItem[] memory voteItems = this.getVoteItems();

        uint256 voteItemsCount = voteItems.length;
        for (uint256 i = 0; i < voteItemsCount; i++) {
            scriptBuilder.addCall(voteItems[i].call.to, voteItems[i].call.data);
        }

        return scriptBuilder.getResult();
    }

    /// @notice Returns the bytecode for creating a new vote on the Aragon Voting contract.
    /// @param description The description of the vote.
    /// @return newVoteBytecode The bytecode for creating a new vote.
    function getNewVoteCallBytecode(string memory description) external view returns (bytes memory newVoteBytecode) {
        newVoteBytecode = CallsScriptBuilder.create(
            address(VOTING_CONTRACT), abi.encodeCall(VOTING_CONTRACT.newVote, (getEVMScript(), description, false, false))
        )._result;
    }

    /// @notice Validates the specific vote on Aragon Voting contract.
    /// @return A boolean value indicating whether the vote is valid.
    function isValidVoteScript(uint256 voteId) external view returns (bool) {
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
        return keccak256(script) == keccak256(getEVMScript());
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
