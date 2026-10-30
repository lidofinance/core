// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {WithdrawalIntent} from "contracts/common/interfaces/WithdrawalIntent.sol";

contract TriggerableWithdrawalsGateway__MockForTriggerableWithdrawalsBus {
    event Mock__TriggerWithdrawalsCalled(address caller, uint256 intentsCount, address refundRecipient, uint256 value);
    event Mock__WithdrawalIntent(bytes pubkey, uint64 amount);

    error Mock__TriggerWithdrawalsReverted();

    uint256 internal _feePerRequest = 1;
    bool internal _shouldRevert;

    function triggerWithdrawals(WithdrawalIntent[] calldata intents, address refundRecipient) external payable {
        if (_shouldRevert) revert Mock__TriggerWithdrawalsReverted();

        emit Mock__TriggerWithdrawalsCalled(msg.sender, intents.length, refundRecipient, msg.value);
        for (uint256 i = 0; i < intents.length; ++i) {
            emit Mock__WithdrawalIntent(intents[i].pubkey, intents[i].amount);
        }

        uint256 totalFee = intents.length * _feePerRequest;
        if (msg.value > totalFee) {
            (bool success, ) = refundRecipient.call{value: msg.value - totalFee}("");
            require(success, "Refund failed");
        }
    }

    function mock__setFeePerRequest(uint256 feePerRequest) external {
        _feePerRequest = feePerRequest;
    }

    function mock__setRevert(bool shouldRevert) external {
        _shouldRevert = shouldRevert;
    }
}
