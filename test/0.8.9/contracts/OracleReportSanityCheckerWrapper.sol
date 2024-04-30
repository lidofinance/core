// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// NB: for testing purposes only
pragma solidity 0.8.9;

import { OracleReportSanityChecker, LimitsList, LimitsListPacked, LimitsListPacker } from "../../../contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";

contract OracleReportSanityCheckerWrapper is OracleReportSanityChecker {
    using LimitsListPacker for LimitsList;

    LimitsListPacked private _limitsListPacked;

    constructor(
        address _lidoLocator,
        address _admin,
        LimitsList memory _limitsList,
        ManagersRoster memory _managersRoster
    ) OracleReportSanityChecker(
        _lidoLocator,
        _admin,
        _limitsList,
        _managersRoster
    ) {}

    function addNegativeRebase(uint64 rebaseValue, uint32 refSlot) public {
        _addNegativeRebase(rebaseValue, refSlot);
    }

    function exposePackedLimits() public view returns (LimitsListPacked memory) {
        return _limitsListPacked;
    }

    function packAndStore() public {
        _limitsListPacked = getOracleReportLimits().pack();
    }
}
