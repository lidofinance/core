// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

/**
 * @dev Mock for ConsolidationBus for ConsolidationMigrator tests
 */
contract ConsolidationBus__MockForConsolidationMigrator {
    event AddConsolidationRequestsCalled(bytes[][] sourcePubkeysGroups, bytes[] targetPubkeys, address caller);

    bytes[][] public lastSourcePubkeysGroups;
    bytes[] public lastTargetPubkeys;
    address public lastCaller;
    uint256 public callCount;

    bool internal _shouldRevert;
    string internal _revertReason;

    function addConsolidationRequests(bytes[][] calldata sourcePubkeysGroups, bytes[] calldata targetPubkeys) external {
        if (_shouldRevert) {
            revert(_revertReason);
        }

        delete lastSourcePubkeysGroups;
        delete lastTargetPubkeys;

        for (uint256 i = 0; i < sourcePubkeysGroups.length; ++i) {
            lastSourcePubkeysGroups.push();
            for (uint256 j = 0; j < sourcePubkeysGroups[i].length; ++j) {
                lastSourcePubkeysGroups[i].push(sourcePubkeysGroups[i][j]);
            }
        }
        for (uint256 i = 0; i < targetPubkeys.length; ++i) {
            lastTargetPubkeys.push(targetPubkeys[i]);
        }
        lastCaller = msg.sender;
        callCount++;

        emit AddConsolidationRequestsCalled(sourcePubkeysGroups, targetPubkeys, msg.sender);
    }

    function mock__setRevert(bool shouldRevert, string calldata reason) external {
        _shouldRevert = shouldRevert;
        _revertReason = reason;
    }

    function getLastSourcePubkeyFromGroup(uint256 groupIndex, uint256 keyIndex) external view returns (bytes memory) {
        return lastSourcePubkeysGroups[groupIndex][keyIndex];
    }

    function getLastTargetPubkey(uint256 index) external view returns (bytes memory) {
        return lastTargetPubkeys[index];
    }

    function getLastGroupsCount() external view returns (uint256) {
        return lastSourcePubkeysGroups.length;
    }

    function getLastGroupSize(uint256 groupIndex) external view returns (uint256) {
        return lastSourcePubkeysGroups[groupIndex].length;
    }

    function getLastTotalPairsCount() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < lastSourcePubkeysGroups.length; ++i) {
            total += lastSourcePubkeysGroups[i].length;
        }
        return total;
    }
}
