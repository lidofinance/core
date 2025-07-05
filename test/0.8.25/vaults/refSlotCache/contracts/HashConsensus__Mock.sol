// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

contract HashConsensus__Mock {
    uint256 private _refSlot;

    constructor(uint256 initialRefSlot) {
        _refSlot = initialRefSlot;
    }

    function getCurrentFrame() external view returns (uint256 refSlot, uint256 reportProcessingDeadlineSlot) {
        return (_refSlot, _refSlot + 100);
    }

    // Test helper functions
    function setRefSlot(uint256 refSlot) external {
        _refSlot = refSlot;
    }
}
