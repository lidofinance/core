// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

/**
 * @title AccessControlMutuallyConfirmable
 * @author Lido
 * @notice An extension of AccessControlEnumerable that allows exectuing functions by mutual confirmation.
 * @dev This contract extends AccessControlEnumerable and adds a confirmation mechanism in the form of a modifier.
 */
abstract contract AccessControlMutuallyConfirmable is AccessControlEnumerable {
    /**
     * @notice Tracks confirmations
     * - callId: unique identifier for the call, derived as `keccak256(msg.data)`
     * - role: role that confirmed the action
     * - timestamp: timestamp of the confirmation.
     */
    mapping(bytes callData => mapping(bytes32 role => uint256 expiryTimestamp)) public confirmations;

    /**
     * @notice Confirmation lifetime in seconds; after this period, the confirmation expires and no longer counts.
     */
    uint256 public confirmLifetime;

    /**
     * @dev Restricts execution of the function unless confirmed by all specified roles.
     * Confirmation, in this context, is a call to the same function with the same arguments.
     *
     * The confirmation process works as follows:
     * 1. When a role member calls the function:
     *    - Their confirmation is counted immediately
     *    - If not enough confirmations exist, their confirmation is recorded
     *    - If they're not a member of any of the specified roles, the call reverts
     *
     * 2. Confirmation counting:
     *    - Counts the current caller's confirmations if they're a member of any of the specified roles
     *    - Counts existing confirmations that are not expired, i.e. lifetime is not exceeded
     *
     * 3. Execution:
     *    - If all members of the specified roles have confirmed, executes the function
     *    - On successful execution, clears all confirmations for this call
     *    - If not enough confirmations, stores the current confirmations
     *    - Thus, if the caller has all the roles, the function is executed immediately
     *
     * 4. Gas Optimization:
     *    - Confirmations are stored in a deferred manner using a memory array
     *    - Confirmation storage writes only occur if the function cannot be executed immediately
     *    - This prevents unnecessary storage writes when all confirmations are present,
     *      because the confirmations are cleared anyway after the function is executed,
     *    - i.e. this optimization is beneficial for the deciding caller and
     *      saves 1 storage write for each role the deciding caller has
     *
     * @param _roles Array of role identifiers that must confirm the call in order to execute it
     *
     * @notice Confirmations past their lifetime are not counted and must be recast
     * @notice Only members of the specified roles can submit confirmations
     * @notice The order of confirmations does not matter
     *
     */
    modifier onlyMutuallyConfirmed(bytes32[] memory _roles) {
        if (_roles.length == 0) revert ZeroConfirmingRoles();
        if (confirmLifetime == 0) revert ConfirmLifetimeNotSet();

        uint256 numberOfRoles = _roles.length;
        uint256 numberOfConfirms = 0;
        bool[] memory deferredConfirms = new bool[](numberOfRoles);
        bool isRoleMember = false;

        for (uint256 i = 0; i < numberOfRoles; ++i) {
            bytes32 role = _roles[i];

            if (super.hasRole(role, msg.sender)) {
                isRoleMember = true;
                numberOfConfirms++;
                deferredConfirms[i] = true;

                emit RoleMemberConfirmed(msg.sender, role, block.timestamp, msg.data);
            } else if (confirmations[msg.data][role] >= block.timestamp) {
                numberOfConfirms++;
            }
        }

        if (!isRoleMember) revert SenderNotMember();

        if (numberOfConfirms == numberOfRoles) {
            for (uint256 i = 0; i < numberOfRoles; ++i) {
                bytes32 role = _roles[i];
                delete confirmations[msg.data][role];
            }
            _;
        } else {
            for (uint256 i = 0; i < numberOfRoles; ++i) {
                if (deferredConfirms[i]) {
                    bytes32 role = _roles[i];
                    confirmations[msg.data][role] = block.timestamp + confirmLifetime;
                }
            }
        }
    }

    /**
     * @notice Sets the confirmation lifetime.
     * Confirmation lifetime is a period during which the confirmation is counted. Once the period is over,
     * the confirmation is considered expired, no longer counts and must be recasted for the confirmation to go through.
     * @param _newConfirmLifetime The new confirmation lifetime in seconds.
     */
    function _setConfirmLifetime(uint256 _newConfirmLifetime) internal {
        if (_newConfirmLifetime == 0) revert ConfirmLifetimeCannotBeZero();

        uint256 oldConfirmLifetime = confirmLifetime;
        confirmLifetime = _newConfirmLifetime;

        emit ConfirmLifetimeSet(msg.sender, oldConfirmLifetime, _newConfirmLifetime);
    }

    /**
     * @dev Emitted when the confirmation lifetime is set.
     * @param oldConfirmLifetime The old confirmation lifetime.
     * @param newConfirmLifetime The new confirmation lifetime.
     */
    event ConfirmLifetimeSet(address indexed sender, uint256 oldConfirmLifetime, uint256 newConfirmLifetime);

    /**
     * @dev Emitted when a role member confirms.
     * @param member The address of the confirming member.
     * @param role The role of the confirming member.
     * @param timestamp The timestamp of the confirmation.
     * @param data The msg.data of the confirmation (selector + arguments).
     */
    event RoleMemberConfirmed(address indexed member, bytes32 indexed role, uint256 timestamp, bytes data);

    /**
     * @dev Thrown when attempting to set confirmation lifetime to zero.
     */
    error ConfirmLifetimeCannotBeZero();

    /**
     * @dev Thrown when attempting to confirm when the confirmation lifetime is not set.
     */
    error ConfirmLifetimeNotSet();

    /**
     * @dev Thrown when a caller without a required role attempts to confirm.
     */
    error SenderNotMember();

    /**
     * @dev Thrown when the roles array is empty.
     */
    error ZeroConfirmingRoles();
}
