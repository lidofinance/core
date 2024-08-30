// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {StETHPermit} from "contracts/0.4.24/StETHPermit.sol";
import {StETH__HarnessForWithdrawalQueueDeploy} from "./StETH__HarnessForWithdrawalQueueDeploy.sol";

contract StETHPermit__HarnessForWithdrawalQueueDeploy is StETHPermit, StETH__HarnessForWithdrawalQueueDeploy {
    function initializeEIP712StETH(address _eip712StETH) external {
        _initializeEIP712StETH(_eip712StETH);
    }

    function getBlockTime() external view returns (uint256) {
        return block.timestamp;
    }
}
