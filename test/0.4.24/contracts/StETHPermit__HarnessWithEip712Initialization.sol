// SPDX-License-Identifier: UNLICENSED
// for test purposes only

pragma solidity 0.4.24;

import {StETHPermit} from "contracts/0.4.24/StETHPermit.sol";
import {StETH__MockForLidoMiscMinimal} from "test/0.4.24/contracts/StETH__MockForLidoMiscMinimal.sol";

contract StETHPermit__HarnessWithEip712Initialization is StETHPermit, StETH__MockForLidoMiscMinimal {
    constructor(address _holder) payable StETH__MockForLidoMiscMinimal(_holder) {}

    function initializeEIP712StETH(address _eip712StETH) external {
        _initializeEIP712StETH(_eip712StETH);
    }
}
