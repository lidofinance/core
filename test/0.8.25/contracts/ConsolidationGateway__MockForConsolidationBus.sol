// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

contract ConsolidationGateway__MockForConsolidationBus {
    event AddConsolidationRequestsCalled(
        bytes[][] sourcePubkeysGroups,
        bytes[] targetPubkeys,
        address refundRecipient,
        uint256 value
    );

    uint256 internal _fee;
    bool internal _shouldRevert;
    string internal _revertReason;

    constructor() {
        _fee = 1;
    }

    function addConsolidationRequests(
        bytes[][] calldata sourcePubkeysGroups,
        bytes[] calldata targetPubkeys,
        address refundRecipient
    ) external payable {
        if (_shouldRevert) {
            revert(_revertReason);
        }

        emit AddConsolidationRequestsCalled(sourcePubkeysGroups, targetPubkeys, refundRecipient, msg.value);

        // Count total requests and simulate refund if excess ETH was sent
        uint256 totalRequests = 0;
        for (uint256 i = 0; i < sourcePubkeysGroups.length; ++i) {
            totalRequests += sourcePubkeysGroups[i].length;
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
