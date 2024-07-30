// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.4.24;

import "contracts/0.4.24/StETHPermit.sol";
import "./StETH__MockForWithdrawalQueueDeploy.sol";

/**
 * @dev Only for testing purposes!
 * StETHPermit mock version of mintable/burnable/stoppable token.
 */
contract StETHPermit__MockForWithdrawalQueueDeploy is StETHPermit, StETH__MockForWithdrawalQueueDeploy {
    function initializeEIP712StETH(address _eip712StETH) external {
        _initializeEIP712StETH(_eip712StETH);
    }

    function getBlockTime() external view returns (uint256) {
        return block.timestamp;
    }
}
