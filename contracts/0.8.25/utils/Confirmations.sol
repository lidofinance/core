// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

/**
 * @title Confirmations
 * @author Lido
 * @notice A contract that allows executing functions by mutual confirmation.
 */
abstract contract Confirmations {

    /**
     * @notice Tracks confirmations
     * @dev We cannot set confirmExpiry to 0 because this means that all confirmations have to be in the same block,
     *      which can never be guaranteed. And, more importantly, if the `_setConfirmExpiry` is restricted by
     *      the `onlyConfirmed` modifier, the confirmation expiry will be tricky to change.
     *      This is why confirmExpiry is private, set to a default value of 1 hour and cannot be set to 0.
     *
     * Storage layout:
     * - callData: msg.data of the call (selector + arguments)
     * - role: role that confirmed the action
     * - expiryTimestamp: timestamp of the confirmation
     *
     * - confirmExpiry: confirmation expiry period in seconds
     */
    struct ConfirmationStorage {
        mapping(bytes callData => mapping(bytes32 role => uint256 expiryTimestamp)) confirmations;
        uint256 confirmExpiry;
    }

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         keccak256(abi.encode(uint256(keccak256("Lido.Vaults.storage.Confirmations")) - 1)) & ~bytes32(uint256(0xff))
     */
    bytes32 private constant CONFIRMATIONS_STORAGE_LOCATION =
        0x1b8b5828bd311c11f60881dedc705c95b2fbc3408c25f5c1964af0a81ceb0900;


    /**
     * @notice Minimal confirmation expiry in seconds.
     */
    uint256 public constant MIN_CONFIRM_EXPIRY = 1 hours;

    /**
     * @notice Maximal confirmation expiry in seconds.
     */
    uint256 public constant MAX_CONFIRM_EXPIRY = 30 days;

    function __Confirmations_init() internal {
        _setConfirmExpiry(1 days);
    }


    /**
     * @notice Returns the confirmation expiry.
     * @return The confirmation expiry in seconds.
     */
    function getConfirmExpiry() public view returns (uint256) {
        return _getConfirmationsStorage().confirmExpiry;
    }

    /**
     * @notice Returns the confirmation expiry for a given call data and confirmer.
     * @param _callData The call data of the function.
     * @param _role The role of the confirmer.
     * @return The confirmation expiration timestamp or 0 if there was no confirmation from this role to this _callData
     */
    function confirmation(bytes memory _callData, bytes32 _role) external view returns (uint256) {
        return _getConfirmationsStorage().confirmations[_callData][_role];
    }

    /**
     * @dev Processes a confirmation from the current caller and checks if all required confirmations are present.
     * Confirmation, in this context, is a call to the same function with the same arguments.
     * This is a one-off operation that either:
     * - Collects the current caller's confirmation and returns false if not enough confirmations
     * - Or clears all confirmations and returns true if all required confirmations are present
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
     * 3. Confirmation Management:
     *    - If all members of the specified roles have confirmed:
     *      a. Clears all confirmations for this call
     *      b. Returns true to indicate that the function can be executed
     *    - If not enough confirmations:
     *      a. Stores the current confirmations
     *      b. Returns false to indicate that the function cannot be executed yet
     *    - Thus, if the caller has all the roles, returns true immediately
     *
     * 4. Gas Optimization:
     *    - Confirmations are stored in a deferred manner using a memory array
     *    - Confirmation storage writes only occur if the function cannot be executed immediately
     *    - This prevents unnecessary storage writes when all confirmations are present,
     *      because the confirmations are cleared anyway after the function is executed,
     *    - i.e. this optimization is beneficial for the deciding caller and
     *      saves 1 storage write for each role the deciding caller has
     *
     * @param _calldata msg.data of the call (selector + arguments)
     * @param _roles Array of role identifiers that must confirm the call in order to execute it
     * @return bool True if all required confirmations are present and the function can be executed, false otherwise
     *
     * @notice Confirmations past their expiry are not counted and must be recast
     * @notice Only members of the specified roles can submit confirmations
     * @notice The order of confirmations does not matter
     *
     */
    function _collectAndCheckConfirmations(bytes calldata _calldata, bytes32[] memory _roles) internal returns (bool) {
        if (_roles.length == 0) revert ZeroConfirmingRoles();

        uint256 numberOfRoles = _roles.length;
        uint256 numberOfConfirms = 0;
        bool[] memory deferredConfirms = new bool[](numberOfRoles);
        bool isRoleMember = false;

        ConfirmationStorage storage $ = _getConfirmationsStorage();
        uint256 expiryTimestamp = block.timestamp + $.confirmExpiry;

        for (uint256 i = 0; i < numberOfRoles; ++i) {
            bytes32 role = _roles[i];
            if (_isValidConfirmer(role)) {
                isRoleMember = true;
                numberOfConfirms++;
                deferredConfirms[i] = true;

                emit RoleMemberConfirmed(msg.sender, role, block.timestamp, expiryTimestamp, msg.data);
            } else if ($.confirmations[_calldata][role] >= block.timestamp) {
                numberOfConfirms++;
            }
        }

        if (!isRoleMember) revert SenderNotMember();

        if (numberOfConfirms == numberOfRoles) {
            for (uint256 i = 0; i < numberOfRoles; ++i) {
                bytes32 role = _roles[i];
                delete $.confirmations[_calldata][role];
            }
            return true;
        } else {
            for (uint256 i = 0; i < numberOfRoles; ++i) {
                if (deferredConfirms[i]) {
                    bytes32 role = _roles[i];
                    $.confirmations[_calldata][role] = expiryTimestamp;
                }
            }
            return false;
        }
    }

    /**
     * @notice Checks if the caller is a valid confirmer
     * @param _role The role to check
     * @return bool True if the caller is a valid confirmer
     */
    function _isValidConfirmer(bytes32 _role) internal view virtual returns (bool);

    /**
     * @dev Sets the confirmation expiry.
     * Confirmation expiry is a period during which the confirmation is counted. Once expired,
     * the confirmation no longer counts and must be recasted for the confirmation to go through.
     * @dev Does not retroactively apply to existing confirmations.
     * @param _newConfirmExpiry The new confirmation expiry in seconds.
     */
    function _setConfirmExpiry(uint256 _newConfirmExpiry) internal {
        _validateConfirmExpiry(_newConfirmExpiry);

        ConfirmationStorage storage $ = _getConfirmationsStorage();

        uint256 oldConfirmExpiry = $.confirmExpiry;
        $.confirmExpiry = _newConfirmExpiry;

        emit ConfirmExpirySet(msg.sender, oldConfirmExpiry, _newConfirmExpiry);
    }

    function _validateConfirmExpiry(uint256 _newConfirmExpiry) internal pure {
        if (_newConfirmExpiry < MIN_CONFIRM_EXPIRY || _newConfirmExpiry > MAX_CONFIRM_EXPIRY)
            revert ConfirmExpiryOutOfBounds();
    }

    function _getConfirmationsStorage() private pure returns (ConfirmationStorage storage $) {
        assembly {
            $.slot := CONFIRMATIONS_STORAGE_LOCATION
        }
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
     * @param confirmTimestamp The timestamp of the confirmation.
     * @param expiryTimestamp The timestamp when this confirmation expires.
     * @param data The msg.data of the confirmation (selector + arguments).
     */
    event RoleMemberConfirmed(address indexed member, bytes32 indexed role, uint256 confirmTimestamp, uint256 expiryTimestamp, bytes data);

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
