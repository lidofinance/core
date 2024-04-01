// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

contract SanityFuse {

    uint256 private _expiryTimestamp;
    address private _fuseCommittee;

    uint256 private _lastSuccessfulReports;
    bool private _isFuseBlown;

    constructor(uint256 expiryTimestamp, address fuseCommittee) {
        _expiryTimestamp = expiryTimestamp;
        _fuseCommittee = fuseCommittee;
    }

    function blowFuse() external {
        require(msg.sender == _fuseCommittee, "SanityFuse: only committee can blow the fuse");
        require(block.timestamp < _expiryTimestamp, "SanityFuse: fuse is not expired yet");
        require(_lastSuccessfulReports == 0, "SanityFuse: fuse can be blown only after unsuccessful report");
        _isFuseBlown = true;
    }

    function consultFuse(bool succussfulReport) internal returns (bool) {
        if (block.timestamp >= _expiryTimestamp) {
            return false;
        }
        if (succussfulReport) {
            _lastSuccessfulReports += 1;
        } else {
            _lastSuccessfulReports = 0;
        }
        if (_lastSuccessfulReports >= 3 && _isFuseBlown) {
            _isFuseBlown = false;
        }
        return _isFuseBlown;
    }

}
