// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

interface IVoting {
    enum VotePhase {
        Main,
        Objection,
        Closed
    }

    function getVote(uint256 _voteId)
        external
        view
        returns (
            bool open,
            bool executed,
            uint64 startDate,
            uint64 snapshotBlock,
            uint64 supportRequired,
            uint64 minAcceptQuorum,
            uint256 yea,
            uint256 nay,
            uint256 votingPower,
            bytes memory script,
            VotePhase phase
        );

    function newVote(
        bytes calldata _executionScript,
        string calldata _metadata,
        bool, /* _castVote_deprecated */
        bool /* _executesIfDecided_deprecated */
    ) external;
}
