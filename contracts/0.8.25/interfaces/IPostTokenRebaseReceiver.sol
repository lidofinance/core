// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity >=0.5.0;

/// @notice An interface to subscribe on the `stETH` token rebases (defined in the `Lido` core contract)
interface IPostTokenRebaseReceiver {
    /// @notice Is called in the context of `Lido.handleOracleReport` to notify the subscribers about each token rebase
    function handlePostTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external;
}
