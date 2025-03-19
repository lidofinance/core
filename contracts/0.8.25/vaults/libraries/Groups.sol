// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

library Groups {

    struct Group {
        uint96 shareLimit;
        uint96 mintedShares;
        uint256[] tiers;
        uint256 tiersCount;
    }

    struct Storage {
        Group[] groups;
        mapping(uint256 id => uint256 index) groupIndex;
    }

    function initialize(Storage storage self) internal {
        self.groups.push(Group({shareLimit: 0, mintedShares: 0, tiers: new uint256[](0), tiersCount: 0}));
    }

    function register(Storage storage self, uint256 groupId, uint256 shareLimit) internal {
        if (self.groupIndex[groupId] > 0) revert GroupExists();

        //1-ind
        self.groupIndex[groupId] = self.groups.length;
        self.groups.push(
            Group({
                shareLimit: uint96(shareLimit),
                mintedShares: 0,
                tiers: new uint256[](0),
                tiersCount: 0
            })
        );

        emit GroupAdded(groupId, uint96(shareLimit));
    }

    function updateShareLimit(Storage storage self, uint256 groupId, uint256 newShareLimit) internal {
        uint256 groupIdx = self.groupIndex[groupId];
        if (groupIdx == 0) revert GroupNotExists();

        self.groups[groupIdx].shareLimit = uint96(newShareLimit);

        emit GroupShareLimitUpdated(groupId, uint96(newShareLimit));
    }

    error GroupExists();
    error GroupNotExists();

    event GroupAdded(uint256 indexed groupId, uint256 shareLimit);
    event GroupShareLimitUpdated(uint256 indexed groupId, uint256 shareLimit);
}
