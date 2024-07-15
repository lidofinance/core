// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

interface ILegacyOracle {
    function getBeaconSpec() external view returns (
        uint64 epochsPerFrame,
        uint64 slotsPerEpoch,
        uint64 secondsPerSlot,
        uint64 genesisTime
    );

    function getLastCompletedEpochId() external view returns (uint256);
}
