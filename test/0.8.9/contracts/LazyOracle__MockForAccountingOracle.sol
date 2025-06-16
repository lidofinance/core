// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract LazyOracle__MockForAccountingOracle {
    event Mock__UpdateReportData(uint256 _timestamp, bytes32 _vaultsDataTreeRoot, string _vaultsDataReportCid);

    function updateReportData(
        uint256 _timestamp,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataReportCid
    ) external {
        emit Mock__UpdateReportData(_timestamp, _vaultsDataTreeRoot, _vaultsDataReportCid);
    }
}
