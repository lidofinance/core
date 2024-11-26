// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.9;

import {OracleReportSanityChecker, LimitsList, LimitsListPacked, LimitsListPacker} from "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";

contract OracleReportSanityCheckerWrapper is OracleReportSanityChecker {
    using LimitsListPacker for LimitsList;

    LimitsListPacked private _limitsListPacked;

    constructor(
        address _lidoLocator,
        address _admin,
        LimitsList memory _limitsList
    ) OracleReportSanityChecker(
        _lidoLocator,
        _admin,
        _limitsList
    ) {}

    function addReportData(uint256 _timestamp, uint256 _exitedValidatorsCount, uint256 _negativeCLRebase) public {
        _addReportData(_timestamp, _exitedValidatorsCount, _negativeCLRebase);
    }

    function sumNegativeRebasesNotOlderThan(uint256 _timestamp) public view returns (uint256) {
        return _sumNegativeRebasesNotOlderThan(_timestamp);
    }

    function exitedValidatorsAtTimestamp(uint256 _timestamp) public view returns (uint256) {
        return _exitedValidatorsAtTimestamp(_timestamp);
    }

    function exposePackedLimits() public view returns (LimitsListPacked memory) {
        return _limitsListPacked;
    }

    function packAndStore() public {
        _limitsListPacked = getOracleReportLimits().pack();
    }
}
