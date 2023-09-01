// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.4.1 (access/AccessControlEnumerable.sol)
//
// Mock contract for AccessControlEnumerable. Copied from tree:
// https://github.com/OpenZeppelin/openzeppelin-contracts/blob/6bd6b76d1156e20e45d1016f355d154141c7e5b9/contracts/mocks/AccessControlEnumerableMock.sol
//
pragma solidity 0.8.9;

import "../utils/access/AccessControlEnumerable.sol";

contract AccessControlEnumerableMock is AccessControlEnumerable {
    constructor() {
        _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    }

    function setRoleAdmin(bytes32 roleId, bytes32 adminRoleId) public {
        _setRoleAdmin(roleId, adminRoleId);
    }

    function senderProtected(bytes32 roleId) public onlyRole(roleId) {}
}
