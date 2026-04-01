// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";

interface IConsolidationGateway {
    struct ConsolidationWitnessGroup {
        bytes[] sourcePubkeys;
        IPredepositGuarantee.ValidatorWitness targetWitness;
    }

    function addConsolidationRequests(
        ConsolidationWitnessGroup[] calldata groups,
        address refundRecipient
    ) external payable;
}

contract ConsolidationGateway__MockForConsolidationBus {
    event AddConsolidationRequestsCalled(uint256 groupsCount, address refundRecipient, uint256 value);

    uint256 internal _fee;
    bool internal _shouldRevert;
    string internal _revertReason;

    constructor() {
        _fee = 1;
    }

    function addConsolidationRequests(
        IConsolidationGateway.ConsolidationWitnessGroup[] calldata groups,
        address refundRecipient
    ) external payable {
        if (_shouldRevert) {
            revert(_revertReason);
        }

        emit AddConsolidationRequestsCalled(groups.length, refundRecipient, msg.value);

        // Count total requests and simulate refund if excess ETH was sent
        uint256 totalRequests = 0;
        for (uint256 i = 0; i < groups.length; ++i) {
            totalRequests += groups[i].sourcePubkeys.length;
        }
        uint256 totalFee = totalRequests * _fee;
        if (msg.value > totalFee) {
            (bool success, ) = refundRecipient.call{value: msg.value - totalFee}("");
            require(success, "Refund failed");
        }
    }

    function mock__setFee(uint256 fee) external {
        _fee = fee;
    }

    function mock__setRevert(bool shouldRevert, string calldata reason) external {
        _shouldRevert = shouldRevert;
        _revertReason = reason;
    }

    function mock__getFee() external view returns (uint256) {
        return _fee;
    }
}
