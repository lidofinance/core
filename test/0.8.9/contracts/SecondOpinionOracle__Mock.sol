// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// NB: for testing purposes only
pragma solidity 0.8.9;

interface ISecondOpinionOracle {
    function getReportHash(uint256 refSlot) external view returns (bool exists, bytes32 reportHash);
}

contract SecondOpinionOracle__Mock is ISecondOpinionOracle {
    mapping(uint256 => bytes32) public reportHashes;

    function setReportHash(uint256 refSlot, bytes32 reportHash) external {
        reportHashes[refSlot] = reportHash;
    }

    function removeReport(uint256 refSlot) external {
        delete reportHashes[refSlot];
    }

    function getReportHash(uint256 refSlot) external view override returns (bool exists, bytes32 reportHash) {
        reportHash = reportHashes[refSlot];
        exists = reportHash != bytes32(0);
    }
}
