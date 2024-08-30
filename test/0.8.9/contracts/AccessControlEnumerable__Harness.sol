// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {AccessControlEnumerable} from "contracts/0.8.9/utils/access/AccessControlEnumerable.sol";

contract AccessControlEnumerable__Harness is AccessControlEnumerable {
    bytes32 public constant TEST_ROLE = keccak256("TEST_ROLE");

    constructor() {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }
}
