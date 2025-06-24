// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {AccessControlConfirmable} from "contracts/0.8.25/utils/AccessControlConfirmable.sol";

contract AccessControlConfirmable__Harness is AccessControlConfirmable {
    bytes32 public constant ROLE_1 = keccak256("ROLE_1");
    bytes32 public constant ROLE_2 = keccak256("ROLE_2");

    uint256 public number;

    constructor(address _admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        __Confirmations_init();
    }

    function confirmingRoles() public pure returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_1;
        roles[1] = ROLE_2;
        return roles;
    }

    function setConfirmExpiry(uint256 _confirmExpiry) external {
        _setConfirmExpiry(_confirmExpiry);
    }

    function setNumber(uint256 _number) external {
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return;
        number = _number;
    }

    function decrementWithZeroRoles() external {
        if (!_collectAndCheckConfirmations(msg.data, new bytes32[](0))) return;
        number--;
    }
}
