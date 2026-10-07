// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

contract WithdrawalVault__MockForTriggerableWithdrawalsGateway {
    event Mock__AddWithdrawalRequestsCalled(bytes[] pubkeys, uint64[] amounts, uint256 value);

    uint256 internal _fee = 1;

    function addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts) external payable {
        emit Mock__AddWithdrawalRequestsCalled(pubkeys, amounts, msg.value);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return _fee;
    }

    function mock__setFee(uint256 fee) external {
        _fee = fee;
    }
}
