// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {PausableUntil} from "contracts/common/utils/PausableUntil.sol";

/**
 * @title PausableUntilWithRoles
 * @notice a `PausableUntil` implementation using OpenZeppelin's `AccessControlEnumerableUpgradeable`
 * @dev the inheriting contract must use `whenNotPaused` modifier from `PausableUntil` to block some functions on pause
 */
abstract contract PausableUntilWithRoles is PausableUntil, AccessControlEnumerableUpgradeable {
    /// @notice role that allows to pause the contract
    bytes32 public constant PAUSE_ROLE = keccak256("PausableUntilWithRoles.PauseRole");
    /// @notice role that allows to resume the contract
    bytes32 public constant RESUME_ROLE = keccak256("PausableUntilWithRoles.ResumeRole");

    /**
     * @notice Resume the contract
     * @dev Reverts if contracts is not paused
     * @dev Reverts if sender has no `RESUME_ROLE`
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pause the contract for a specified period
     * @param _duration pause duration in seconds (use `PAUSE_INFINITELY` for unlimited)
     * @dev Reverts if contract is already paused
     * @dev Reverts if sender has no `PAUSE_ROLE`
     * @dev Reverts if zero duration is passed
     */
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /**
     * @notice Pause the contract until a specified timestamp
     * @param _pauseUntilInclusive the last second to pause until inclusive
     * @dev Reverts if the timestamp is in the past
     * @dev Reverts if sender has no `PAUSE_ROLE`
     * @dev Reverts if contract is already paused
     */
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }
}
