// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StETH__MockForDelegation} from "./StETH__MockForDelegation.sol";

contract VaultHub__MockForDelegation {
    StETH__MockForDelegation public immutable steth;

    constructor(StETH__MockForDelegation _steth) {
        steth = _steth;
    }

    event Mock__VaultDisconnected(address vault);
    event Mock__Rebalanced(uint256 amount);

    function disconnect(address vault) external {
        emit Mock__VaultDisconnected(vault);
    }

    function mintShares(address /* vault */, address recipient, uint256 amount) external {
        steth.mint(recipient, amount);
    }

    function burnShares(address /* vault */, uint256 amount) external {
        steth.burn(amount);
    }

    function voluntaryDisconnect(address _vault) external {
        emit Mock__VaultDisconnected(_vault);
    }

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.value);
    }
}
