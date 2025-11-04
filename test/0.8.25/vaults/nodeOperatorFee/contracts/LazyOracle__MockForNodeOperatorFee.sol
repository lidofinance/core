// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";

contract LazyOracle__MockForNodeOperatorFee {
    uint256 internal quarantineValue_;

    uint64 timestamp;

    function mock__setLatestReportTimestamp(uint64 _timestamp) external {
        if (_timestamp == 0) {
            timestamp = uint64(block.timestamp);
        }
        timestamp = _timestamp;
    }

    function mock__setQuarantineValue(uint256 _quarantineValue) external {
        quarantineValue_ = _quarantineValue;
    }

    function quarantineValue(address) external view returns (uint256) {
        return quarantineValue_;
    }

    function latestReportTimestamp() external view returns (uint64) {
        return timestamp;
    }
}
