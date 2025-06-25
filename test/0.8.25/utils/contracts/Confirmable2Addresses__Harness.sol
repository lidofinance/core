// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Confirmable2Addresses} from "contracts/0.8.25/utils/Confirmable2Addresses.sol";

contract Confirmable2Addresses__Harness is Confirmable2Addresses {
    address public confirmer1;
    address public confirmer2;

    uint256 public number;

    constructor() {
        __Confirmations_init();
    }

    function setConfirmers(address _confirmer1, address _confirmer2) external {
        confirmer1 = _confirmer1;
        confirmer2 = _confirmer2;
    }

    function isConfirmer(address _address) public view returns (bool) {
        return _address == confirmer1 || _address == confirmer2;
    }

    function setNumber(uint256 _number) external {
        if (!_collectAndCheckConfirmations(msg.data, confirmer1, confirmer2)) return;
        number = _number;
    }
}
