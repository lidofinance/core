// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

contract WithdrawalVault__MockForConsolidationGateway {
    event AddConsolidationRequestsCalled(bytes[] sourcePubkeys, bytes[] targetPubkeys);

    uint256 internal _fee;

    constructor() {
        _fee = 1;
    }

    function addConsolidationRequests(bytes[] calldata sourcePubkeys, bytes[] calldata targetPubkeys) external payable {
        emit AddConsolidationRequestsCalled(sourcePubkeys, targetPubkeys);
    }

    function getConsolidationRequestFee() external view returns (uint256) {
        return _fee;
    }

    function mock__setFee(uint256 fee) external {
        _fee = fee;
    }
}
