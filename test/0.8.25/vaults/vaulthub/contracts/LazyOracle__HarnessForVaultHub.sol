// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

/**
 * @title LazyOracle__HarnessForVaultHub
 * @notice Test harness for LazyOracle that adds helper functions for VaultHub invariant testing
 * @dev Extends the real LazyOracle with test-only functions to control timestamps
 *
 * Note: We shadow latestReportTimestamp() instead of overriding it since the base
 * implementation is not marked as virtual. Tests should cast to this type to access
 * the test version.
 */
contract LazyOracle__HarnessForVaultHub is LazyOracle {
    // Track the last report timestamp for testing
    uint256 private testReportTimestamp;

    constructor(address _lidoLocator) LazyOracle(_lidoLocator) {}

    /**
     * @notice Test helper: Sets the report timestamp to current block.timestamp
     * @dev This simulates a new oracle report being available
     */
    function refreshReportTimestamp() external {
        testReportTimestamp = block.timestamp;
    }

    /**
     * @notice Test helper: Manually set a specific report timestamp
     * @param _timestamp The timestamp to set
     */
    function setReportTimestamp(uint256 _timestamp) external {
        testReportTimestamp = _timestamp;
    }

    /**
     * @notice Returns the test report timestamp for use in applyVaultReport
     * @dev This shadows the base implementation. Call this explicitly on the harness type.
     */
    function getTestReportTimestamp() external view returns (uint256) {
        return testReportTimestamp > 0 ? testReportTimestamp : block.timestamp;
    }
}
