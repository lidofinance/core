// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { AccessControlEnumerable } from "../utils/access/AccessControlEnumerable.sol";
import { SafeCast } from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";
import { ILidoZKOracle } from "./ILidoZKOracle.sol";

contract Tiebreaker is ILidoZKOracle, AccessControlEnumerable {
    using SafeCast for uint256;

    // TODO: separate role to submit reports
    error AdminCannotBeZero();

    struct Report {
        bool success;
        uint64 clBalanceGwei;
        uint32 numValidators;
        uint32 exitedValidators;
    }

    mapping(uint256 => Report) internal _reports;

    constructor(address admin) {
        if (admin == address(0)) revert AdminCannotBeZero();

        _setupRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function submitReport(uint256 refSlot, bool success, uint64 clBalanceGwei,
        uint32 numValidators, uint32 exitedValidators) external
        onlyRole(DEFAULT_ADMIN_ROLE) {
        _reports[refSlot] = Report(success, clBalanceGwei, numValidators, exitedValidators);
    }

    function removeReport(uint256 refSlot) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete _reports[refSlot];
    }

    function getReport(uint256 refSlot) external view override returns (bool, uint256, uint256, uint256) {
        Report memory report = _reports[refSlot];
        return (report.success, report.clBalanceGwei, report.numValidators, report.exitedValidators);
    }

}