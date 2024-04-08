// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

contract SanityFuse {

    event FuseBlown();
    event FuseConsulted(bool isFuseBlown, uint256 successfulReports);

    error FuseCommitteeCannotBeZero();
    error ExpiryTimestampCannotBeInThePast();
    error ExpiryTimestampIsTooDistantFuture();

    uint8 private constant MAX_SUCCESSFUL_REPORTS = 3;

    address private _fuseCommittee;
    uint64 private _expiryTimestamp;

    // 0 - unknown state, > 0 - successful reports count - 1
    uint8 private _successfulReportsCount;
    bool private _isFuseBlown;

    constructor(address fuseCommittee, uint256 expiryTimestamp) {
        if (fuseCommittee == address(0)) revert FuseCommitteeCannotBeZero();
        if (expiryTimestamp <= block.timestamp) revert ExpiryTimestampCannotBeInThePast();
        if (expiryTimestamp > 2**64 - 1) revert ExpiryTimestampIsTooDistantFuture();

        _fuseCommittee = fuseCommittee;
        _expiryTimestamp = uint64(expiryTimestamp);
    }

    function blowFuse() external {
        require(msg.sender == _fuseCommittee, "SanityFuse: only committee can blow the fuse");
        require(block.timestamp < _expiryTimestamp, "SanityFuse: fuse already expired");
        require(_successfulReportsCount == 1, "SanityFuse: fuse can be blown only after unsuccessful report");
        require(_isFuseBlown == false, "SanityFuse: fuse already blown");

        _isFuseBlown = true;
        emit FuseBlown();
    }

    function getSuccessfulReportsCount() public view returns (uint8) {
        return _successfulReportsCount;
    }

    function consultFuse(bool succussfulReport) internal returns (bool) {
        if (block.timestamp >= _expiryTimestamp) {
            return false;
        }
        uint8 lastSuccessfulReports = _successfulReportsCount;
        if (succussfulReport) {
            if (lastSuccessfulReports < MAX_SUCCESSFUL_REPORTS + 1) {
                lastSuccessfulReports += 1;
                _successfulReportsCount = lastSuccessfulReports;
            }
        } else {
            if (lastSuccessfulReports != 1) {
                lastSuccessfulReports = 1;
                _successfulReportsCount = 1;
            }
        }
        if (lastSuccessfulReports >= MAX_SUCCESSFUL_REPORTS + 1 && _isFuseBlown) {
            _isFuseBlown = false;
        }
        emit FuseConsulted(_isFuseBlown, lastSuccessfulReports);
        return _isFuseBlown;
    }

}
