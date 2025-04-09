// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

contract VaultHub__MockForStakingVault {
    address public immutable LIDO_LOCATOR;

    constructor(address _lidoLocator) {
        LIDO_LOCATOR = _lidoLocator;
    }

    event Mock__Rebalanced(address indexed vault, uint256 amount);

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.sender, msg.value);
    }
}
