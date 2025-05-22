// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

/**
 * @title Confirmations
 * @author Lido
 * @notice A contract that allows exectuing functions by mutual confirmation.
 * @dev This contract extends AccessControlEnumerable and adds a confirmation mechanism in the form of a modifier.
 */
abstract contract Confirmations {

    // @notice  keccak256("Lido.Confirmations.confirmers")
    bytes32 internal constant CONFIRMERS_SLOT = 0x356ebac9cff6b130dd4e4529b15906e1f51fb138bb7b5e98bcda6136874c1dd0;

    /**
     * @notice Tracks confirmations
     * @dev We cannot set confirmExpiry to 0 because this means that all confirmations have to be in the same block,
     *      which can never be guaranteed. And, more importantly, if the `_setConfirmExpiry` is restricted by
     *      the `onlyConfirmed` modifier, the confirmation expiry will be tricky to change.
     *      This is why confirmExpiry is private, set to a default value of 1 day and cannot be set to 0.
     *
     * Storage layout:
     * - callData: msg.data of the call (selector + arguments)
     * - confirmer: index of the confirmer that confirmed the action
     * - expiryTimestamp: timestamp of the confirmation
     *
     * - confirmExpiry: confirmation expiry period in seconds
     */
    struct ConfirmationStorage {
      mapping(bytes callData => mapping(uint256 confirmer => uint256 expiryTimestamp)) confirmations;
      uint256 confirmExpiry;
    }

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         keccak256(abi.encode(uint256(keccak256("Lido.Vaults.storage.Confirmations")) - 1)) & ~bytes32(uint256(0xff))
     */
    bytes32 private constant ERC7201_STORAGE_LOCATION =
        0x1b8b5828bd311c11f60881dedc705c95b2fbc3408c25f5c1964af0a81ceb0900;


    /**
     * @notice Minimal confirmation expiry in seconds.
     */
    uint256 public constant MIN_CONFIRM_EXPIRY = 1 days;

    /**
     * @notice Maximal confirmation expiry in seconds.
     */
    uint256 public constant MAX_CONFIRM_EXPIRY = 30 days;

    function __Confirmations_init() internal {
      _setConfirmExpiry(MIN_CONFIRM_EXPIRY);
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
     * @param _index The index of the confirmer.
     * @return The confirmation expiry in seconds.
     */
    function confirmations(bytes memory _callData, uint256 _index) external view returns (uint256) {
        return _getConfirmationsStorage().confirmations[_callData][_index];
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
     * @param _confirmersCount Number of confirmers that must confirm the call in order to execute it
     *
     * @notice Confirmations past their expiry are not counted and must be recast
     * @notice Only members of the specified roles can submit confirmations
     * @notice The order of confirmations does not matter
     *
     */
    function _checkConfirmations(bytes calldata _calldata, uint256 _confirmersCount) internal returns (bool) {
        if (_confirmersCount == 0) revert ZeroConfirmingRoles();

        uint256 numberOfConfirms = 0;
        bool[] memory deferredConfirms = new bool[](_confirmersCount);
        bool isRoleMember = false;

        ConfirmationStorage storage $ = _getConfirmationsStorage();
        uint256 expiryTimestamp = block.timestamp + $.confirmExpiry;

        for (uint256 i = 0; i < _confirmersCount; ++i) {
            if (_isValidConfirmer(i)) {
                isRoleMember = true;
                numberOfConfirms++;
                deferredConfirms[i] = true;

                _emitEventConfirmation(msg.sender, i, expiryTimestamp, _calldata);
            } else if ($.confirmations[_calldata][i] >= block.timestamp) {
                numberOfConfirms++;
            }
        }

        if (!isRoleMember) revert SenderNotMember();

        if (numberOfConfirms == _confirmersCount) {
            for (uint256 i = 0; i < _confirmersCount; ++i) {
                delete $.confirmations[_calldata][i];
            }
            return true;
        } else {
            for (uint256 i = 0; i < _confirmersCount; ++i) {
                if (deferredConfirms[i]) {
                    $.confirmations[_calldata][i] = expiryTimestamp;
                }
            }
            return false;
        }
    }

    /**
     * @notice Checks if the caller is a valid confirmer
     * @param _confirmerIndex Index of the confirmer to check
     * @return bool True if the caller is a valid confirmer
     */
    function _isValidConfirmer(uint256 _confirmerIndex) internal view virtual returns (bool);

    /**
     * @dev Emitted when a role member confirms.
     * @param _confirmer The index of the confirming member.
     * @param _confirmerIndex The role of the confirming member.
     * @param _expiryTimestamp The timestamp of the confirmation.
     * @param _data The msg.data of the confirmation (selector + arguments).
     */
    function _emitEventConfirmation(address _confirmer, uint256 _confirmerIndex, uint256 _expiryTimestamp, bytes memory _data) internal virtual;

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

        ConfirmationStorage storage $ = _getConfirmationsStorage();

        uint256 oldConfirmExpiry = $.confirmExpiry;
        $.confirmExpiry = _newConfirmExpiry;

        emit ConfirmExpirySet(msg.sender, oldConfirmExpiry, _newConfirmExpiry);
    }

    function _getConfirmationsStorage() private pure returns (ConfirmationStorage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    /**
     * @dev Emitted when the confirmation expiry is set.
     * @param oldConfirmExpiry The old confirmation expiry.
     * @param newConfirmExpiry The new confirmation expiry.
     */
    event ConfirmExpirySet(address indexed sender, uint256 oldConfirmExpiry, uint256 newConfirmExpiry);

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
