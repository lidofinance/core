// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

interface IReportAsyncProcessor {
    /// @notice Submits a consensus report for processing.
    ///
    /// Note that submitting the report doesn't require the processor to start processing it right
    /// away, this can happen later (see `getLastProcessingRefSlot`). Until processing is started,
    /// HashConsensus is free to reach consensus on another report for the same reporting frame an
    /// submit it using this same function, or to lose the consensus on the submitted report,
    /// notifying the processor via `discardConsensusReport`.
    ///
    function submitConsensusReport(bytes32 report, uint256 refSlot, uint256 deadline) external;

    /// @notice Notifies that the report for the given ref. slot is not a consensus report anymore
    /// and should be discarded. This can happen when a member changes their report, is removed
    /// from the set, or when the quorum value gets increased.
    ///
    /// Only called when, for the given reference slot:
    ///
    ///   1. there previously was a consensus report; AND
    ///   1. processing of the consensus report hasn't started yet; AND
    ///   2. report processing deadline is not expired yet; AND
    ///   3. there's no consensus report now (otherwise, `submitConsensusReport` is called instead).
    ///
    /// Can be called even when there's no submitted non-discarded consensus report for the current
    /// reference slot, i.e. can be called multiple times in succession.
    ///
    function discardConsensusReport(uint256 refSlot) external;

    /// @notice Returns the last reference slot for which processing of the report was started.
    ///
    /// HashConsensus won't submit reports for any slot less than or equal to this slot.
    ///
    function getLastProcessingRefSlot() external view returns (uint256);

    /// @notice Returns the current consensus version.
    ///
    /// Consensus version must change every time consensus rules change, meaning that
    /// an oracle looking at the same reference slot would calculate a different hash.
    ///
    /// HashConsensus won't accept member reports any consensus version different form the
    /// one returned from this function.
    ///
    function getConsensusVersion() external view returns (uint256);
}