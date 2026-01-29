// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

/**
 * @dev Mock for ConsolidationBus for ConsolidationMigrator tests
 */
contract ConsolidationBus__MockForConsolidationMigrator {
    event AddConsolidationRequestsCalled(bytes[] sourcePubkeys, bytes[] targetPubkeys, address caller);

    bytes[] public lastSourcePubkeys;
    bytes[] public lastTargetPubkeys;
    address public lastCaller;
    uint256 public callCount;

    bool internal _shouldRevert;
    string internal _revertReason;

    function addConsolidationRequests(bytes[] calldata sourcePubkeys, bytes[] calldata targetPubkeys) external {
        if (_shouldRevert) {
            revert(_revertReason);
        }

        delete lastSourcePubkeys;
        delete lastTargetPubkeys;

        for (uint256 i = 0; i < sourcePubkeys.length; ++i) {
            lastSourcePubkeys.push(sourcePubkeys[i]);
        }
        for (uint256 i = 0; i < targetPubkeys.length; ++i) {
            lastTargetPubkeys.push(targetPubkeys[i]);
        }
        lastCaller = msg.sender;
        callCount++;

        emit AddConsolidationRequestsCalled(sourcePubkeys, targetPubkeys, msg.sender);
    }

    function mock__setRevert(bool shouldRevert, string calldata reason) external {
        _shouldRevert = shouldRevert;
        _revertReason = reason;
    }

    function getLastSourcePubkey(uint256 index) external view returns (bytes memory) {
        return lastSourcePubkeys[index];
    }

    function getLastTargetPubkey(uint256 index) external view returns (bytes memory) {
        return lastTargetPubkeys[index];
    }

    function getLastBatchSize() external view returns (uint256) {
        return lastSourcePubkeys.length;
    }
}
