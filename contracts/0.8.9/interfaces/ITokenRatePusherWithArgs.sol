// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

/// @notice An interface for an entity that pushes token rate and consumes the full per-rebase
///         payload forwarded from `Accounting.handleOracleReport` via the `TokenRateNotifier`.
/// @dev This is the args-bearing variant of `ITokenRatePusher`. An observer registered with the
///      `WithArgs` kind is called with the full rebase payload instead of the no-arg
///      `pushTokenRate()`. Field semantics mirror `IPostTokenRebaseReceiver` 1:1.
///
///      Implementers MUST return `true` from `supportsInterface` for this interface's id;
///      `TokenRateNotifier.addObserver` validates it against the requested `WithArgs` kind.
interface ITokenRatePusherWithArgs {
    /// @notice Pushes token rate and receives the rebase payload that accompanied the notification.
    /// @param _reportTimestamp    Timestamp of the oracle report data snapshot moment.
    /// @param _timeElapsed        Time elapsed since the previous applied report, in seconds.
    /// @param _preTotalShares     Total stETH shares before this rebase.
    /// @param _preTotalEther      Total pooled ether before this rebase.
    /// @param _postTotalShares    Total stETH shares after this rebase (post-fee mint).
    /// @param _postTotalEther     Total pooled ether after this rebase.
    /// @param _sharesMintedAsFees Amount of stETH shares minted as the whole Lido protocol fee
    ///        during this rebase (treasury + node operator fees combined). PER-REBASE value, NOT
    ///        cumulative; may be `0` for a non-profitable report.
    function pushTokenRate(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external;
}
