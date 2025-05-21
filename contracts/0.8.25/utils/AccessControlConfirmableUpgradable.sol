// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;


import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

/**
 * @title AccessControlEnumerableUpgradeable
 * @author Lido
 * @notice An extension of AccessControlEnumerable that allows exectuing functions by mutual confirmation.
 * @dev This contract extends AccessControlEnumerableUpgradeable and adds a confirmation mechanism in the form of a modifier.
 */
abstract contract AccessControlConfirmableUpgradable is AccessControlEnumerableUpgradeable {
    /**
     * @notice Tracks confirmations
     * - callData: msg.data of the call (selector + arguments)
     * - confirmer: address that confirmed the action
     * - timestamp: timestamp of the confirmation.
     * @custom:storage-location erc7201:Lido.Vaults.storage.AccessControlConfirmable
     */
    struct AccessControlConfirmableStorage {
        mapping(bytes callData => mapping(address confirmer => uint256 timestamp)) confirmations;
    }

    // keccak256(abi.encode(uint256(keccak256("Lido.Vaults.storage.AccessControlConfirmable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant AccessControlConfirmableLocation = 0xe8806442efec4597f9ac0d96b1f792ecc71551d84ac81f638d7872506422d000;

    /**
     * @dev Restricts execution of the function unless confirmed by all specified confirmers.
     * Confirmation, in this context, is a call to the same function with the same arguments.
     *
     * The confirmation process works as follows:
     * 1. When a role member calls the function:
     *    - Their confirmation is counted immediately
     *    - If not enough confirmations exist, their confirmation is recorded
     *    - If they're not a member of any of the specified confirmers, the call reverts
     *
     * 2. Confirmation counting:
     *    - Counts the current caller's confirmations if they're a member of any of the specified confirmers
     *    - Counts existing confirmations
     *
     * 3. Execution:
     *    - If all members of the specified confirmers have confirmed, executes the function
     *    - On successful execution, clears all confirmations for this call
     *    - If not enough confirmations, stores the current confirmations
     *    - Thus, if the caller has all the confirmers, the function is executed immediately
     *
     * 4. Gas Optimization:
     *    - Confirmations are stored in a deferred manner using a memory array
     *    - Confirmation storage writes only occur if the function cannot be executed immediately
     *    - This prevents unnecessary storage writes when all confirmations are present,
     *      because the confirmations are cleared anyway after the function is executed,
     *    - i.e. this optimization is beneficial for the deciding caller and
     *      saves 1 storage write for each confirmer the deciding caller has
     *
     * @param _confirmers Array of addresses that must confirm the call in order to execute it
     *
     * @notice Confirmations past their expiry are not counted and must be recast
     * @notice Only members of the specified confirmers can submit confirmations
     * @notice The order of confirmations does not matter
     *
     */
    function _checkConfirmations(address[] memory _confirmers) internal returns (bool) {
        if (_confirmers.length == 0) revert ZeroConfirmers();

        uint256 numberOfConfirmers = _confirmers.length;
        uint256 numberOfConfirms = 0;
        bool[] memory deferredConfirms = new bool[](numberOfConfirmers);
        bool isRoleMember = false;
        uint256 timestamp = block.timestamp;

        AccessControlConfirmableStorage storage $ = _getAccessControlConfirmableStorage();

        for (uint256 i = 0; i < numberOfConfirmers; ++i) {
            address confirmer = _confirmers[i];

            if (msg.sender == confirmer) {
                isRoleMember = true;
                numberOfConfirms++;
                deferredConfirms[i] = true;

                emit MemberConfirmed(msg.sender, timestamp, msg.data);
            } else if ($.confirmations[msg.data][confirmer] > 0) {
                numberOfConfirms++;
            }
        }

        if (!isRoleMember) revert SenderNotMember();

        if (numberOfConfirms == numberOfConfirmers) {
            for (uint256 i = 0; i < numberOfConfirmers; ++i) {
                address confirmer = _confirmers[i];
                delete $.confirmations[msg.data][confirmer];
            }
            return true;
        } else {
            for (uint256 i = 0; i < numberOfConfirmers; ++i) {
                if (deferredConfirms[i]) {
                    address confirmer = _confirmers[i];
                    $.confirmations[msg.data][confirmer] = timestamp;
                }
            }
            return false;
        }
    }

    function confirmations(bytes memory _callData, address _confirmer) external view returns (uint256) {
        return _getAccessControlConfirmableStorage().confirmations[_callData][_confirmer];
    }

    function _getAccessControlConfirmableStorage() private pure returns (AccessControlConfirmableStorage storage $) {
        assembly {
            $.slot := AccessControlConfirmableLocation
        }
    }

    /**
     * @dev Emitted when a role member confirms.
     * @param member The address of the confirming member.
     * @param timestamp The timestamp of the confirmation.
     * @param data The msg.data of the confirmation (selector + arguments).
     */
    event MemberConfirmed(address indexed member, uint256 timestamp, bytes data);

    /**
     * @dev Thrown when a caller without a required role attempts to confirm.
     */
    error SenderNotMember();

    /**
     * @dev Thrown when the confirmers array is empty.
     */
    error ZeroConfirmers();
}
