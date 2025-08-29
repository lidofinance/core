// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {ValidatorExitDelayVerifier, GIndices, GIndex} from "contracts/0.8.25/ValidatorExitDelayVerifier.sol";

contract ValidatorExitDelayVerifier__Harness is ValidatorExitDelayVerifier {
    constructor(
        address lidoLocator,
        GIndices memory gIndices,
        uint64 firstSupportedSlot,
        uint64 pivotSlot,
        uint64 capellaSlot,
        uint64 slotsPerHistoricalRoot,
        uint32 slotsPerEpoch,
        uint32 secondsPerSlot,
        uint64 genesisTime,
        uint32 shardCommitteePeriodInSeconds
    )
        ValidatorExitDelayVerifier(
            lidoLocator,
            gIndices,
            firstSupportedSlot,
            pivotSlot,
            capellaSlot,
            slotsPerHistoricalRoot,
            slotsPerEpoch,
            secondsPerSlot,
            genesisTime,
            shardCommitteePeriodInSeconds
        )
    {}

    function getHistoricalBlockRootGI(uint64 recentSlot, uint64 targetSlot) external returns (GIndex gI) {
        return _getHistoricalBlockRootGI(recentSlot, targetSlot);
    }
}
