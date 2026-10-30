// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {ITriggerableWithdrawalsBus} from "contracts/common/interfaces/ITriggerableWithdrawalsBus.sol";

/// @dev Refund recipient that re-enters `processWithdrawalIntents` from its `receive` hook
contract RefundRecipient__MockForTriggerableWithdrawalsBus {
    event Mock__RefundReceived(uint256 value);

    ITriggerableWithdrawalsBus internal immutable BUS;

    uint256 internal _reentriesLeft;

    constructor(address bus) {
        BUS = ITriggerableWithdrawalsBus(bus);
    }

    function mock__setReentries(uint256 reentries) external {
        _reentriesLeft = reentries;
    }

    receive() external payable {
        emit Mock__RefundReceived(msg.value);

        if (_reentriesLeft > 0) {
            --_reentriesLeft;
            BUS.processWithdrawalIntents(1, address(this));
        }
    }
}
