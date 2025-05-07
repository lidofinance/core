// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {CallsScriptBuilder} from "./calls_script_builder.sol";

import {IVoting} from "./interfaces/IVoting.sol";
import {IForwarder} from "./interfaces/IForwarder.sol";

/// @title OmnibusBase
/// @notice Abstract base contract for creating votes for the Aragon Voting.
///
/// @dev Inheriting contracts must implement:
///     - getVoteItems() - to define the specific actions in the proposal
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
