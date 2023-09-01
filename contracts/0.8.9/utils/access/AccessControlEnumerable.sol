// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.4.1 (access/AccessControlEnumerable.sol)
//
// A modified AccessControlEnumerable contract using unstructured storage. Copied from tree:
// https://github.com/OpenZeppelin/openzeppelin-contracts/tree/6bd6b76/contracts/access
//
/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import "@openzeppelin/contracts-v4.4/access/IAccessControlEnumerable.sol";
import "@openzeppelin/contracts-v4.4/utils/structs/EnumerableSet.sol";

import "./AccessControl.sol";

/**
 * @dev Extension of {AccessControl} that allows enumerating the members of each role.
 */
abstract contract AccessControlEnumerable is IAccessControlEnumerable, AccessControl {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @dev Storage slot: mapping(bytes32 => EnumerableSet.AddressSet) _roleMembers
    bytes32 private constant ROLE_MEMBERS_POSITION = keccak256("openzeppelin.AccessControlEnumerable._roleMembers");

    function _storageRoleMembers() private pure returns (
        mapping(bytes32 => EnumerableSet.AddressSet) storage _roleMembers
    ) {
        bytes32 position = ROLE_MEMBERS_POSITION;
        assembly { _roleMembers.slot := position }
    }

    /**
     * @dev See {IERC165-supportsInterface}.
     */
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IAccessControlEnumerable).interfaceId || super.supportsInterface(interfaceId);
    }

    /**
     * @dev Returns one of the accounts that have `role`. `index` must be a
     * value between 0 and {getRoleMemberCount}, non-inclusive.
     *
     * Role bearers are not sorted in any particular way, and their ordering may
     * change at any point.
     *
     * WARNING: When using {getRoleMember} and {getRoleMemberCount}, make sure
     * you perform all queries on the same block. See the following
     * https://forum.openzeppelin.com/t/iterating-over-elements-on-enumerableset-in-openzeppelin-contracts/2296[forum post]
     * for more information.
     */
    function getRoleMember(bytes32 role, uint256 index) public view override returns (address) {
        return _storageRoleMembers()[role].at(index);
    }

    /**
     * @dev Returns the number of accounts that have `role`. Can be used
     * together with {getRoleMember} to enumerate all bearers of a role.
     */
    function getRoleMemberCount(bytes32 role) public view override returns (uint256) {
        return _storageRoleMembers()[role].length();
    }

    /**
     * @dev Overload {_grantRole} to track enumerable memberships
     */
    function _grantRole(bytes32 role, address account) internal virtual override {
        super._grantRole(role, account);
        _storageRoleMembers()[role].add(account);
    }

    /**
     * @dev Overload {_revokeRole} to track enumerable memberships
     */
    function _revokeRole(bytes32 role, address account) internal virtual override {
        super._revokeRole(role, account);
        _storageRoleMembers()[role].remove(account);
    }
}
