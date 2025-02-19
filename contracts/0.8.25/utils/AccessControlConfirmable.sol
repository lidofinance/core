// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

/**
 * @title AccessControlConfirmable
 * @author Lido
 * @notice An extension of AccessControlEnumerable that allows exectuing functions by mutual confirmation.
 * @dev This contract extends AccessControlEnumerable and adds a confirmation mechanism in the form of a modifier.
 */
abstract contract AccessControlConfirmable is AccessControlEnumerable {
    /**
     * @notice Tracks confirmations
     * - callData: msg.data of the call (selector + arguments)
     * - role: role that confirmed the action
     * - expiryTimestamp: timestamp of the confirmation.
     */
    mapping(bytes callData => mapping(bytes32 role => uint256 expiryTimestamp)) public confirmations;

    /**
     * @notice Minimal confirmation expiry in seconds.
     */
    uint256 public constant MIN_CONFIRM_EXPIRY = 1 days;

    /**
     * @notice Maximal confirmation expiry in seconds.
     */
    uint256 public constant MAX_CONFIRM_EXPIRY = 30 days;

    /**
     * @notice Confirmation expiry in seconds; after this period, the confirmation expires and no longer counts.
     * @dev We cannot set this to 0 because this means that all confirmations have to be in the same block,
     *      which can never be guaranteed. And, more importantly, if the `_setConfirmExpiry` is restricted by
     *      the `onlyConfirmed` modifier, the confirmation expiry will be tricky to change.
     *      This is why this variable is private, set to a default value of 1 day and cannot be set to 0.
     */
    uint256 private confirmExpiry = MIN_CONFIRM_EXPIRY;

    /**
     * @notice Returns the confirmation expiry.
     * @return The confirmation expiry in seconds.
     */
    function getConfirmExpiry() public view returns (uint256) {
        return confirmExpiry;
    }

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
     *    - Counts existing confirmations that are not expired, i.e. expiry is not exceeded
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
     * @notice Confirmations past their expiry are not counted and must be recast
     * @notice Only members of the specified roles can submit confirmations
     * @notice The order of confirmations does not matter
     *
     */
    modifier onlyConfirmed(bytes32[] memory _roles) {
        if (_roles.length == 0) revert ZeroConfirmingRoles();

        uint256 numberOfRoles = _roles.length;
        uint256 numberOfConfirms = 0;
        bool[] memory deferredConfirms = new bool[](numberOfRoles);
        bool isRoleMember = false;
        uint256 expiryTimestamp = block.timestamp + confirmExpiry;

        for (uint256 i = 0; i < numberOfRoles; ++i) {
            bytes32 role = _roles[i];

            if (super.hasRole(role, msg.sender)) {
                isRoleMember = true;
                numberOfConfirms++;
                deferredConfirms[i] = true;

                emit RoleMemberConfirmed(msg.sender, role, expiryTimestamp, msg.data);
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
                    confirmations[msg.data][role] = expiryTimestamp;
                }
            }
        }
    }

    /**
     * @dev Sets the confirmation expiry.
     * Confirmation expiry is a period during which the confirmation is counted. Once expired,
     * the confirmation no longer counts and must be recasted for the confirmation to go through.
     * @dev Does not retroactively apply to existing confirmations.
     * @param _newConfirmExpiry The new confirmation expiry in seconds.
     */
    function _setConfirmExpiry(uint256 _newConfirmExpiry) internal {
        if (_newConfirmExpiry < MIN_CONFIRM_EXPIRY || _newConfirmExpiry > MAX_CONFIRM_EXPIRY)
            revert ConfirmExpiryOutOfBounds();

        uint256 oldConfirmExpiry = confirmExpiry;
        confirmExpiry = _newConfirmExpiry;

        emit ConfirmExpirySet(msg.sender, oldConfirmExpiry, _newConfirmExpiry);
    }

    /**
     * @dev Emitted when the confirmation expiry is set.
     * @param oldConfirmExpiry The old confirmation expiry.
     * @param newConfirmExpiry The new confirmation expiry.
     */
    event ConfirmExpirySet(address indexed sender, uint256 oldConfirmExpiry, uint256 newConfirmExpiry);

    /**
     * @dev Emitted when a role member confirms.
     * @param member The address of the confirming member.
     * @param role The role of the confirming member.
     * @param expiryTimestamp The timestamp of the confirmation.
     * @param data The msg.data of the confirmation (selector + arguments).
     */
    event RoleMemberConfirmed(address indexed member, bytes32 indexed role, uint256 expiryTimestamp, bytes data);

    /**
     * @dev Thrown when attempting to set confirmation expiry out of bounds.
     */
    error ConfirmExpiryOutOfBounds();

    /**
     * @dev Thrown when a caller without a required role attempts to confirm.
     */
    error SenderNotMember();

    /**
     * @dev Thrown when the roles array is empty.
     */
    error ZeroConfirmingRoles();
}
