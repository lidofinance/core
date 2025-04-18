// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StETH__MockForNodeOperatorFee} from "./StETH__MockForNodeOperatorFee.sol";

contract VaultHub__MockForNodeOperatorFee {
    uint256 public constant REPORT_FRESHNESS_DELTA = 1 days;

    address public immutable LIDO_LOCATOR;
    StETH__MockForNodeOperatorFee public immutable steth;

    constructor(address _lidoLocator, StETH__MockForNodeOperatorFee _steth) {
        LIDO_LOCATOR = _lidoLocator;
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
