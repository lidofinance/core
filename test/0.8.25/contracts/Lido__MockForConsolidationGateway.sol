// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

contract Lido__MockForConsolidationGateway {
    bool public canDepositFlag = true;

    function mock__setCanDeposit(bool _value) external {
        canDepositFlag = _value;
    }

    function canDeposit() external view returns (bool) {
        return canDepositFlag;
    }
}
