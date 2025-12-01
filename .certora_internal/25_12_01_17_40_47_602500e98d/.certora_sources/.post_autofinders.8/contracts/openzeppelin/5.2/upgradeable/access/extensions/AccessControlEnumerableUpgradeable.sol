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

    function _getAccessControlEnumerableStorage() private pure returns (AccessControlEnumerableStorage storage $) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b20000, 1037618709170) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b20001, 0) }
        assembly {
            $.slot := AccessControlEnumerableStorageLocation
        }
    }

    function __AccessControlEnumerable_init() internal logInternal691()onlyInitializing {
    }modifier logInternal691() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b30000, 1037618709171) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b30001, 0) } _; }

    function __AccessControlEnumerable_init_unchained() internal logInternal693()onlyInitializing {
    }modifier logInternal693() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b50000, 1037618709173) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b50001, 0) } _; }
    /**
     * @dev See {IERC165-supportsInterface}.
     */
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02870000, 1037618709127) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02870001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02871000, interfaceId) }
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
    function getRoleMember(bytes32 role, uint256 index) public view virtual returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff028a0000, 1037618709130) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff028a0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff028a1000, role) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff028a1001, index) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010086,0)}
        return $._roleMembers[role].at(index);
    }

    /**
     * @dev Returns the number of accounts that have `role`. Can be used
     * together with {getRoleMember} to enumerate all bearers of a role.
     */
    function getRoleMemberCount(bytes32 role) public view virtual returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02890000, 1037618709129) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02890001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02891000, role) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010087,0)}
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
    function getRoleMembers(bytes32 role) public view virtual returns (address[] memory) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02820000, 1037618709122) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02820001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02821000, role) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010088,0)}
        return $._roleMembers[role].values();
    }

    /**
     * @dev Overload {AccessControl-_grantRole} to track enumerable memberships
     */
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b60000, 1037618709174) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b60001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b61000, role) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b61001, account) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010089,0)}
        bool granted = super._grantRole(role, account);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000008a,granted)}
        if (granted) {
            $._roleMembers[role].add(account);
        }
        return granted;
    }

    /**
     * @dev Overload {AccessControl-_revokeRole} to track enumerable memberships
     */
    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b40000, 1037618709172) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b40001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b41000, role) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02b41001, account) }
        AccessControlEnumerableStorage storage $ = _getAccessControlEnumerableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001008b,0)}
        bool revoked = super._revokeRole(role, account);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000008c,revoked)}
        if (revoked) {
            $._roleMembers[role].remove(account);
        }
        return revoked;
    }
}
