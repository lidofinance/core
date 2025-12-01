// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (access/extensions/AccessControlEnumerable.sol)

pragma solidity ^0.8.20;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";
import {AccessControlUpgradeable} from "../AccessControlUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";
import {Initializable} from "../../proxy/utils/Initializable.sol";

/**
 * @dev Extension of {AccessControl} that allows enumerating the members of each role.
 */
abstract contract AccessControlEnumerableUpgradeable is Initializable, IAccessControlEnumerable, AccessControlUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @custom:storage-location erc7201:openzeppelin.storage.AccessControlEnumerable
    struct AccessControlEnumerableStorage {
        mapping(bytes32 role => EnumerableSet.AddressSet) _roleMembers;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.AccessControlEnumerable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant AccessControlEnumerableStorageLocation = 0xc1f6fe24621ce81ec5827caf0253cadb74709b061630e6b55e82371705932000;

    function _getAccessControlEnumerableStorage() private pure returns (AccessControlEnumerableStorage storage $) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01990000, 1037618708889) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01990001, 0) }
        assembly {
            $.slot := AccessControlEnumerableStorageLocation
        }
    }

    function __AccessControlEnumerable_init() internal logInternal410()onlyInitializing {
    }modifier logInternal410() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019a0000, 1037618708890) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019a0001, 0) } _; }

    function __AccessControlEnumerable_init_unchained() internal logInternal412()onlyInitializing {
    }modifier logInternal412() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019c0000, 1037618708892) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019c0001, 0) } _; }
    /**
     * @dev See {IERC165-supportsInterface}.
     */
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011a0000, 1037618708762) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011a0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011a1000, interfaceId) }
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
    function getRoleMember(bytes32 role, uint256 index) public view virtual returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011e0000, 1037618708766) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011e0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011e1000, role) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011e1001, index) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001013a,0)}
        return $._roleMembers[role].at(index);
    }

    /**
     * @dev Returns the number of accounts that have `role`. Can be used
     * together with {getRoleMember} to enumerate all bearers of a role.
     */
    function getRoleMemberCount(bytes32 role) public view virtual returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011c0000, 1037618708764) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011c0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011c1000, role) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001013b,0)}
        return $._roleMembers[role].length();
    }

    /**
     * @dev Return all accounts that have `role`
     *
     * WARNING: This operation will copy the entire storage to memory, which can be quite expensive. This is designed
     * to mostly be used by view accessors that are queried without any gas fees. Developers should keep in mind that
     * this function has an unbounded cost, and using it as part of a state-changing function may render the function
     * uncallable if the set grows to a point where copying to memory consumes too much gas to fit in a block.
     */
    function getRoleMembers(bytes32 role) public view virtual returns (address[] memory) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011b0000, 1037618708763) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011b0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff011b1000, role) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001013c,0)}
        return $._roleMembers[role].values();
    }

    /**
     * @dev Overload {AccessControl-_grantRole} to track enumerable memberships
     */
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019d0000, 1037618708893) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019d0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019d1000, role) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019d1001, account) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001013d,0)}
        bool granted = super._grantRole(role, account);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000013e,granted)}
        if (granted) {
            $._roleMembers[role].add(account);
        }
        return granted;
    }

    /**
     * @dev Overload {AccessControl-_revokeRole} to track enumerable memberships
     */
    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019b0000, 1037618708891) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019b0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019b1000, role) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff019b1001, account) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001013f,0)}
        bool revoked = super._revokeRole(role, account);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000140,revoked)}
        if (revoked) {
            $._roleMembers[role].remove(account);
        }
        return revoked;
    }
}
