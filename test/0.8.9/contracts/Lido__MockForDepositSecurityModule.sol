// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForDepositSecurityModule {
    bool internal canDepositState;
    constructor() {
        canDepositState = true;
    }

    function setCanDeposit(bool _canDeposit) external {
        canDepositState = _canDeposit;
    }

    function canDeposit() external view returns (bool) {
        return canDepositState;
    }
}
