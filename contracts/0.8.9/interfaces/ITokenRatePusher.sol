// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// taken from https://github.com/lidofinance/lido-l2-with-steth/blob/780c0af4e4a517258a8ca2756fd84c9492582dac/contracts/lido/interfaces/ITokenRatePusher.sol

pragma solidity 0.8.9;

/// @author kovalgek
/// @notice An interface for entity that pushes token rate.
interface ITokenRatePusher {
    /// @notice Pushes token rate to L2 by depositing zero token amount.
    function pushTokenRate() external;
}
