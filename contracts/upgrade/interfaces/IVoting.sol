// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24 <0.9.0;

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
