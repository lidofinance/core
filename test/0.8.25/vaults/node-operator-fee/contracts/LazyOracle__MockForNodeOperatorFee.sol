// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";

contract LazyOracle__MockForNodeOperatorFee {
    LazyOracle.QuarantineInfo internal quarantineInfo;

    uint64 timestamp;

    function mock__setLatestReportTimestamp(uint64 _timestamp) external {
        if (_timestamp == 0) {
            timestamp = uint64(block.timestamp);
        }
        timestamp = _timestamp;
    }

    function mock__setQuarantineInfo(LazyOracle.QuarantineInfo memory _quarantineInfo) external {
        quarantineInfo = _quarantineInfo;
    }

    function vaultQuarantine(address) external view returns (LazyOracle.QuarantineInfo memory) {
        return quarantineInfo;
    }

    function latestReportTimestamp() external view returns (uint64) {
        return timestamp;
    }
}
