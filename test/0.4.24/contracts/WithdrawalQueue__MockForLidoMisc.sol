// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

contract WithdrawalQueue__MockForLidoMisc {
    bool public isBunkerModeActive;
    uint256 public unfinalizedStETH;

    function mock__bunkerMode(bool active) external {
        isBunkerModeActive = active;
    }

    function mock__unfinalizedStETH(uint256 amount) external {
        unfinalizedStETH = amount;
    }
}
