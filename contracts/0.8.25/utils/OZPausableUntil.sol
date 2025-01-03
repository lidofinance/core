// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";
import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

/// @title OZPausableUntil is a PausableUntil reference implementation using OpenZeppelin's AccessControlEnumerableUpgradeable
/// @author folkyatina
abstract contract OZPausableUntil is PausableUntil, AccessControlEnumerableUpgradeable {
    /// @notice role that allows to pause the hub
    bytes32 public constant PAUSE_ROLE = keccak256("OZPausableUntil.PauseRole");
    /// @notice role that allows to resume the hub
    bytes32 public constant RESUME_ROLE = keccak256("OZPausableUntil.ResumeRole");

    /// @notice Resume withdrawal requests placement and finalization
    /// @dev Contract is deployed in paused state and should be resumed explicitly
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /// @notice Pause withdrawal requests placement and finalization. Claiming finalized requests will still be available
    /// @param _duration pause duration in seconds (use `PAUSE_INFINITELY` for unlimited)
    /// @dev Reverts if contract is already paused
    /// @dev Reverts reason if sender has no `PAUSE_ROLE`
    /// @dev Reverts if zero duration is passed
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /// @notice Pause withdrawal requests placement and finalization. Claiming finalized requests will still be available
    /// @param _pauseUntilInclusive the last second to pause until inclusive
    /// @dev Reverts if the timestamp is in the past
    /// @dev Reverts if sender has no `PAUSE_ROLE`
    /// @dev Reverts if contract is already paused
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }
}
