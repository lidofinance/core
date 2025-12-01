// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

/// @author kovalgek
/// @notice An interface for entity that pushes token rate.
interface ITokenRatePusher {
    /// @notice Pushes token rate to L2 by depositing zero token amount.
    function pushTokenRate() external;
}
