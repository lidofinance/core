// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { AccessControlEnumerable } from "../utils/access/AccessControlEnumerable.sol";
import { SafeCast } from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";
import { ILidoZKOracle } from "./ILidoZKOracle.sol";

contract MultiproverStorage {
    /// @dev Oracle committee members' addresses array
    address[] internal _memberAddresses;

    /// @dev Oracle committee members quorum value, must be larger than totalMembers // 2
    uint256 internal immutable _quorum;

    constructor(address[] memory members, uint256 quorum) {
        _memberAddresses = members;
        _quorum = quorum;
    }

    function getMembers() external view returns (address[] memory) {
        return _memberAddresses;
    }

    function getQuorum() external view returns (uint256) {
        return _quorum;
    }
}

contract Multiprover is ILidoZKOracle, AccessControlEnumerable {
    using SafeCast for uint256;

    error AdminCannotBeZero();

    // zk Oracles commetee
    error DuplicateMember();
    error NonMember();
    error QuorumTooSmall(uint256 minQuorum, uint256 receivedQuorum);
    error AddressCannotBeZero();

    error NoConsensus();

    struct Report {
        bool success;
        uint256 clBalanceGwei;
        uint256 numValidators;
        uint256 exitedValidators;
    }

    address internal _members;

    constructor(
        address admin,
        address[] memory members,
        uint256 quorum
    ) {
        if (admin == address(0)) revert AdminCannotBeZero();

        _setupRole(DEFAULT_ADMIN_ROLE, admin);

        setMembers(members, quorum);
    }

    function setMembers(address[] memory members, uint256 quorum) public
        onlyRole(DEFAULT_ADMIN_ROLE) {
            uint256 totalMembers = members.length;
            if (quorum <= totalMembers / 2) {
                revert QuorumTooSmall(totalMembers / 2 + 1, quorum);
            }
        _members = address(new MultiproverStorage(members, quorum));
    }

    function getMembers() public view returns (
        address[] memory addresses
    ) {
        return MultiproverStorage(_members).getMembers();
    }

    function getQuorum() public view returns (uint256) {
        return MultiproverStorage(_members).getQuorum();
    }

    ///
    /// Implementation: LidoZKOracle
    ///

    // Helper function to check if two reports are identical
    function _areReportsIdentical(Report memory a, Report memory b) internal pure returns (bool) {
        return a.success == b.success &&
               a.clBalanceGwei == b.clBalanceGwei &&
               a.numValidators == b.numValidators &&
               a.exitedValidators == b.exitedValidators;
    }

    // Helper function to request a report from an oracle
    function _requestReportFromOracle(ILidoZKOracle oracle, uint256 refSlot) internal view
        returns (Report memory)    {
        (bool success, uint256 clBalanceGwei, uint256 numValidators, uint256 exitedValidators) = oracle.getReport(refSlot);
        return Report(success, clBalanceGwei, numValidators, exitedValidators);
    }

    function getReport(uint256 refSlot) external view override returns  (
        bool success,
        uint256 clBalanceGwei,
        uint256 numValidators,
        uint256 exitedValidators
    ) {
        address[] memory members = getMembers();
        uint256 quorum = getQuorum();
        Report[] memory reportsData = new Report[](members.length);
        uint256[] memory reportCounts = new uint256[](members.length);
        uint256 reports = 0;

        uint256 length = members.length;
        for (uint256 i = 0; i < length; i++) {
            ILidoZKOracle oracle = ILidoZKOracle(members[i]);
            Report memory report = _requestReportFromOracle(oracle, refSlot);
            if (report.success) {
                uint256 currentReportCount = 0;
                for (uint256 j = 0; j < reports; j++) {
                    if (_areReportsIdentical(reportsData[j], report)) {
                        reportCounts[j]++;
                        currentReportCount = reportCounts[j];
                        break;
                    }
                }
                if (currentReportCount == 0) {
                    reportsData[reports] = report;
                    reportCounts[reports] = 1;
                    currentReportCount = 1;
                    reports++;
                }
                if (currentReportCount >= quorum) {
                    return (report.success, report.clBalanceGwei, report.numValidators, report.exitedValidators);
                }
            }
        }
        revert NoConsensus();
   }
}
