// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: UNLICENSED

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

type Duration is uint32;
type Timestamp is uint40;

enum ProposalStatus {
    NotExist,
    Submitted,
    Scheduled,
    Executed,
    Cancelled
}

struct ExternalCall {
    address target;
    uint96 value;
    bytes payload;
}

interface ITimelock {
    struct ProposalDetails {
        uint256 id;
        address executor;
        Timestamp submittedAt;
        Timestamp scheduledAt;
        ProposalStatus status;
    }
    function getProposalDetails(uint256 proposalId) external view returns (ProposalDetails memory proposalDetails);
    function getProposalsCount() external view returns (uint256 count);
    function getAfterSubmitDelay() external view returns (Duration);
    function getAfterScheduleDelay() external view returns (Duration);
    function canSchedule(uint256 proposalId) external view returns (bool);
    function canExecute(uint256 proposalId) external view returns (bool);
    function execute(uint256 proposalId) external;
}
