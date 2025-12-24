// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {StETHPermit} from "contracts/0.4.24/StETHPermit.sol";
import {StETH__Harness} from "test/0.4.24/contracts/StETH__Harness.sol";

contract StETHPermit__HarnessWithEip712Initialization is StETHPermit, StETH__Harness {
    constructor(address _holder) public payable StETH__Harness(_holder) {}

    function initializeEIP712StETH(address _eip712StETH) external {
        _initializeEIP712StETH(_eip712StETH);
    }
}
