// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

/**
 * @dev Mock for ConsolidationBus for ConsolidationMigrator tests
 */
contract ConsolidationBus__MockForConsolidationMigrator {
    struct ConsolidationGroup {
        bytes[] sourcePubkeys;
        bytes targetPubkey;
    }

    event AddConsolidationRequestsCalled(uint256 groupsCount, address caller);

    ConsolidationGroup[] internal _lastGroups;
    address public lastCaller;
    uint256 public callCount;

    bool internal _shouldRevert;
    string internal _revertReason;

    function addConsolidationRequests(ConsolidationGroup[] calldata groups) external {
        if (_shouldRevert) {
            revert(_revertReason);
        }

        delete _lastGroups;

        for (uint256 i = 0; i < groups.length; ++i) {
            _lastGroups.push();
            _lastGroups[i].targetPubkey = groups[i].targetPubkey;
            for (uint256 j = 0; j < groups[i].sourcePubkeys.length; ++j) {
                _lastGroups[i].sourcePubkeys.push(groups[i].sourcePubkeys[j]);
            }
        }
        lastCaller = msg.sender;
        callCount++;

        emit AddConsolidationRequestsCalled(groups.length, msg.sender);
    }

    function mock__setRevert(bool shouldRevert, string calldata reason) external {
        _shouldRevert = shouldRevert;
        _revertReason = reason;
    }

    function getLastSourcePubkeyFromGroup(uint256 groupIndex, uint256 keyIndex) external view returns (bytes memory) {
        return _lastGroups[groupIndex].sourcePubkeys[keyIndex];
    }

    function getLastTargetPubkey(uint256 index) external view returns (bytes memory) {
        return _lastGroups[index].targetPubkey;
    }

    function getLastGroupsCount() external view returns (uint256) {
        return _lastGroups.length;
    }

    function getLastGroupSize(uint256 groupIndex) external view returns (uint256) {
        return _lastGroups[groupIndex].sourcePubkeys.length;
    }

    function getLastTotalPairsCount() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < _lastGroups.length; ++i) {
            total += _lastGroups[i].sourcePubkeys.length;
        }
        return total;
    }
}
