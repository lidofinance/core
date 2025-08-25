// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract HashConsensus__MockForVaultHub {
    function getCurrentFrame() external pure returns (uint256 refSlot, uint256 reportProcessingDeadlineSlot) {
        return (79_000, 0);
    }
}
