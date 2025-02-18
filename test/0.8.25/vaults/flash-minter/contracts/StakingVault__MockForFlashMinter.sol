// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Ownable} from "@openzeppelin/contracts-v5.2/access/Ownable.sol";

contract StakingVault__MockForFlashMinter is Ownable {
    uint256 public locked;
    uint256 public valuation;

    constructor(address _owner) Ownable(_owner) {}

    function fund() external payable {
        valuation += msg.value;
    }

    function lock(uint256 _lockedAmount) external {
        locked = _lockedAmount;
    }
}
