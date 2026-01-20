// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: UNLICENSED


// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

/// @notice Represents an external call to a specific address with an optional ETH transfer.
/// @param target The address to call.
/// @param value The amount of ETH (in wei) to transfer with the call, capped at approximately 7.9 billion ETH.
/// @param payload The calldata payload sent to the target address.
struct ExternalCall {
    address target;
    uint96 value;
    bytes payload;
}

/// @notice The info about the registered proposer and associated executor.
/// @param account Address of the proposer.
/// @param executor The address of the executor assigned to execute proposals submitted by the proposer.
struct Proposer {
    address account;
    address executor;
}

interface IDualGovernance {
    function submitProposal(
        ExternalCall[] calldata calls,
        string calldata metadata
    ) external returns (uint256 proposalId);

    function scheduleProposal(uint256 proposalId) external;

    /// @notice Returns the information about all registered proposers.
    /// @return proposers An array of `Proposer` structs containing the data of all registered proposers.
    function getProposers() external view returns (Proposer[] memory proposers);

    event ProposalSubmitted(uint256 indexed id, address indexed executor, ExternalCall[] calls);
}
