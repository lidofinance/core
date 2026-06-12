// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract HashConsensus__MockForRedeemsBuffer {
    uint256 private _refSlot;

    constructor(uint256 initialRefSlot) {
        _refSlot = initialRefSlot;
    }

    function getCurrentFrame() external view returns (uint256 refSlot, uint256 reportProcessingDeadlineSlot) {
        return (_refSlot, _refSlot + 100);
    }

    function setRefSlot(uint256 refSlot) external {
        _refSlot = refSlot;
    }
}
