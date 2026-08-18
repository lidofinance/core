// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {ISecondOpinionOracle} from "../interfaces/ISecondOpinionOracle.sol";

/// @title Stores Accounting Oracle report hashes confirmed by an independent committee.
contract SecondOpinionOracle is AccessControlEnumerable, ISecondOpinionOracle {
    bytes32 public constant SUBMIT_REPORT_HASH_ROLE = keccak256("SUBMIT_REPORT_HASH_ROLE");

    mapping(uint256 => bytes32) private _reportHashes;

    constructor(address _admin, address _committee) {
        if (_admin == address(0)) revert AdminCannotBeZero();
        if (_committee == address(0)) revert CommitteeCannotBeZero();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(SUBMIT_REPORT_HASH_ROLE, _committee);
    }

    /// @notice Stores or replaces the committee-confirmed report hash for a reference slot.
    /// @dev A zero hash removes the confirmation.
    function setReportHash(uint256 _refSlot, bytes32 _reportHash) external onlyRole(SUBMIT_REPORT_HASH_ROLE) {
        _reportHashes[_refSlot] = _reportHash;
        emit ReportHashSet(_refSlot, _reportHash);
    }

    function getReportHash(uint256 _refSlot) external view override returns (bool exists, bytes32 reportHash) {
        reportHash = _reportHashes[_refSlot];
        exists = reportHash != bytes32(0);
    }

    event ReportHashSet(uint256 indexed refSlot, bytes32 indexed reportHash);

    error AdminCannotBeZero();
    error CommitteeCannotBeZero();
}
