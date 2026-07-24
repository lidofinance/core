// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

/// @notice Minimal mock to control MaxEB weights for ValidatorsExitBus tests
contract OracleReportSanityChecker__MockForExitBusWeights {
    uint256 private _w1;
    uint256 private _w2;

    constructor(uint256 w1, uint256 w2) {
        _w1 = w1;
        _w2 = w2;
    }

    function setWeights(uint256 w1, uint256 w2) external {
        _w1 = w1;
        _w2 = w2;
    }

    function getMaxEffectiveBalanceWeightWCType01() external view returns (uint256) {
        return _w1;
    }

    function getMaxEffectiveBalanceWeightWCType02() external view returns (uint256) {
        return _w2;
    }
}
