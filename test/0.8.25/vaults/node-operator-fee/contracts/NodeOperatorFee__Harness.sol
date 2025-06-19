// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {NodeOperatorFee} from "contracts/0.8.25/vaults/dashboard/NodeOperatorFee.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

contract NodeOperatorFee__Harness is NodeOperatorFee {
    constructor(address _vaultHub, address _lidoLocator) NodeOperatorFee(_vaultHub, _lidoLocator) {}

    function initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) external {
        super._initialize(_defaultAdmin, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);
    }
}
