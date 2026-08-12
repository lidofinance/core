// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

contract Lido__MockForTopUpGateway {
    bool public canDepositFlag = true;

    function setCanDeposit(bool value) external {
        canDepositFlag = value;
    }

    function canDeposit() external view returns (bool) {
        return canDepositFlag;
    }
}
