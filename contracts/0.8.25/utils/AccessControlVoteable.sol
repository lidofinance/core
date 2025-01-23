// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

abstract contract AccessControlVoteable is AccessControlEnumerable {
    /**
     * @notice Tracks committee votes
     * - callId: unique identifier for the call, derived as `keccak256(msg.data)`
     * - role: role that voted
     * - voteTimestamp: timestamp of the vote.
     * The term "voting" refers to the entire voting process through which vote-restricted actions are performed.
     * The term "vote" refers to a single individual vote cast by a committee member.
     */
    mapping(bytes32 callId => mapping(bytes32 role => uint256 voteTimestamp)) public votings;

    /**
     * @notice Vote lifetime in seconds; after this period, the vote expires and no longer counts.
     */
    uint256 public voteLifetime;

    constructor(uint256 _voteLifetime) {
        _setVoteLifetime(_voteLifetime);
    }

    /**
     * @dev Modifier that implements a mechanism for multi-role committee approval.
     * Each unique function call (identified by msg.data: selector + arguments) requires
     * approval from all committee role members within a specified time window.
     *
     * The voting process works as follows:
     * 1. When a committee member calls the function:
     *    - Their vote is counted immediately
     *    - If not enough votes exist, their vote is recorded
     *    - If they're not a committee member, the call reverts
     *
     * 2. Vote counting:
     *    - Counts the current caller's votes if they're a committee member
     *    - Counts existing votes that are within the voting period
     *    - All votes must occur within the same voting period window
     *
     * 3. Execution:
     *    - If all committee members have voted within the period, executes the function
     *    - On successful execution, clears all voting state for this call
     *    - If not enough votes, stores the current votes
     *    - Thus, if the caller has all the roles, the function is executed immediately
     *
     * 4. Gas Optimization:
     *    - Votes are stored in a deferred manner using a memory array
     *    - Vote storage writes only occur if the function cannot be executed immediately
     *    - This prevents unnecessary storage writes when all votes are present,
     *      because the votes are cleared anyway after the function is executed,
     *    - i.e. this optimization is beneficial for the deciding caller and
     *      saves 1 storage write for each role the deciding caller has
     *
     * @param _committee Array of role identifiers that form the voting committee
     *
     * @notice Votes expire after the voting period and must be recast
     * @notice All committee members must vote within the same voting period
     * @notice Only committee members can initiate votes
     *
     * @custom:security-note Each unique function call (including parameters) requires its own set of votes
     */
    modifier onlyIfVotedBy(bytes32[] memory _committee) {
        bytes32 callId = keccak256(msg.data);
        uint256 committeeSize = _committee.length;
        uint256 votingStart = block.timestamp - voteLifetime;
        uint256 voteTally = 0;
        bool[] memory deferredVotes = new bool[](committeeSize);
        bool isCommitteeMember = false;

        for (uint256 i = 0; i < committeeSize; ++i) {
            bytes32 role = _committee[i];

            if (super.hasRole(role, msg.sender)) {
                isCommitteeMember = true;
                voteTally++;
                deferredVotes[i] = true;

                emit RoleMemberVoted(msg.sender, role, block.timestamp, msg.data);
            } else if (votings[callId][role] >= votingStart) {
                voteTally++;
            }
        }

        if (!isCommitteeMember) revert NotACommitteeMember();

        if (voteTally == committeeSize) {
            for (uint256 i = 0; i < committeeSize; ++i) {
                bytes32 role = _committee[i];
                delete votings[callId][role];
            }
            _;
        } else {
            for (uint256 i = 0; i < committeeSize; ++i) {
                if (deferredVotes[i]) {
                    bytes32 role = _committee[i];
                    votings[callId][role] = block.timestamp;
                }
            }
        }
    }

    /**
     * @notice Sets the vote lifetime.
     * Vote lifetime is a period during which the vote is counted. Once the period is over,
     * the vote is considered expired, no longer counts and must be recasted for the voting to go through.
     * @param _newVoteLifetime The new vote lifetime in seconds.
     */
    function _setVoteLifetime(uint256 _newVoteLifetime) internal {
        if (_newVoteLifetime == 0) revert VoteLifetimeCannotBeZero();

        uint256 oldVoteLifetime = voteLifetime;
        voteLifetime = _newVoteLifetime;

        emit VoteLifetimeSet(msg.sender, oldVoteLifetime, _newVoteLifetime);
    }

    /**
     * @dev Emitted when the vote lifetime is set.
     * @param oldVoteLifetime The old vote lifetime.
     * @param newVoteLifetime The new vote lifetime.
     */
    event VoteLifetimeSet(address indexed sender, uint256 oldVoteLifetime, uint256 newVoteLifetime);

    /**
     * @dev Emitted when a committee member votes.
     * @param member The address of the voting member.
     * @param role The role of the voting member.
     * @param timestamp The timestamp of the vote.
     * @param data The msg.data of the vote.
     */
    event RoleMemberVoted(address indexed member, bytes32 indexed role, uint256 timestamp, bytes data);

    /**
     * @dev Thrown when attempting to set vote lifetime to zero.
     */
    error VoteLifetimeCannotBeZero();

    /**
     * @dev Thrown when a caller without a required role attempts to vote.
     */
    error NotACommitteeMember();
}
