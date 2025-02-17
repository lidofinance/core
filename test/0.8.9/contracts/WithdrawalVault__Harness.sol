// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {WithdrawalVault} from "contracts/0.8.9/WithdrawalVault.sol";

contract WithdrawalVault__Harness is WithdrawalVault {
    constructor(address _lido, address _treasury) WithdrawalVault(_lido, _treasury) {
    }

    function harness__initializeContractVersionTo(uint256 _version) external {
        _initializeContractVersionTo(_version);
    }
}
